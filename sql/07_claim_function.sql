-- Core worker function: claims up to batch_size pending jobs, returns (queue_id, document_id, embedding_version, content).
-- Handles: dedup (cancel superseded versions), crash recovery (mark failed), claiming (lock + increment attempts).
-- FOR UPDATE SKIP LOCKED allows multiple workers to run concurrently.

CREATE OR REPLACE FUNCTION claim_embedding_batch(
  batch_size    int      DEFAULT 10,
  lock_duration interval DEFAULT '5 minutes'
)
RETURNS TABLE (
  queue_id          bigint,
  document_id       uuid,
  embedding_version int,
  content           text
)
LANGUAGE plpgsql AS $$
DECLARE
  rec record;
  doc record;
  claimed int := 0;
BEGIN

-- Dedup: cancel jobs superseded by newer versions
UPDATE embedding_queue eq
  SET outcome = 'cancelled'
  WHERE eq.outcome IS NULL
    AND eq.vt <= now()
    AND EXISTS (
      SELECT 1 FROM embedding_queue newer
      WHERE newer.document_id = eq.document_id
        AND newer.embedding_version > eq.embedding_version
        AND newer.outcome IS NULL
    );

-- Crash recovery: mark jobs as failed if retries exhausted
UPDATE embedding_queue
  SET outcome = 'failed',
      last_error = COALESCE(last_error, 'exceeded max attempts')
  WHERE outcome IS NULL
    AND vt <= now()
    AND attempts >= max_attempts;

-- Claim jobs: lock and return to worker
FOR rec IN
  SELECT eq.id, eq.document_id, eq.embedding_version
  FROM embedding_queue eq
  WHERE eq.outcome IS NULL
    AND eq.vt <= now()
    AND eq.attempts < eq.max_attempts
  ORDER BY eq.vt
  FOR UPDATE SKIP LOCKED
LOOP
  SELECT d.content, d.embedding_version INTO doc
  FROM documents d
  WHERE d.id = rec.document_id;

  -- Skip if document was deleted
  IF NOT FOUND THEN
    UPDATE embedding_queue SET outcome = 'cancelled' WHERE id = rec.id;
    CONTINUE;
  END IF;

  -- Skip if version is stale (content changed mid-embedding)
  IF rec.embedding_version <> doc.embedding_version THEN
    UPDATE embedding_queue SET outcome = 'cancelled' WHERE id = rec.id;
    CONTINUE;
  END IF;

  -- Claim: mark as locked, increment attempts
  UPDATE embedding_queue
    SET vt = now() + lock_duration,
        attempts = embedding_queue.attempts + 1
    WHERE id = rec.id;

  queue_id          := rec.id;
  document_id       := rec.document_id;
  embedding_version := rec.embedding_version;
  content           := doc.content;
  RETURN NEXT;

  claimed := claimed + 1;
  EXIT WHEN claimed >= batch_size;
END LOOP;

END
$$;
