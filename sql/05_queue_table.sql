-- Transactional queue for embedding jobs. Uses visibility timeout (vt) pattern:
-- jobs are invisible until vt <= now(). If a worker crashes, the job becomes visible again after timeout.

CREATE TABLE IF NOT EXISTS embedding_queue (
  id                bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id       uuid          NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  embedding_version int           NOT NULL,  -- Version guard for stale embedding detection
  vt                timestamptz   NOT NULL DEFAULT now(),  -- Visibility timeout
  outcome           text          CHECK (outcome IS NULL OR outcome IN ('completed', 'failed', 'cancelled')),
  attempts          int           NOT NULL DEFAULT 0,
  max_attempts      int           NOT NULL DEFAULT 3,
  last_error        text,
  created_at        timestamptz   NOT NULL DEFAULT now()
);

-- INDEX 1: For workers to claim jobs (SELECT WHERE outcome IS NULL AND vt <= now())
CREATE INDEX IF NOT EXISTS embedding_queue_claim_idx
  ON embedding_queue (vt)
  WHERE outcome IS NULL;

-- INDEX 2: For deduplication by document + version
CREATE INDEX IF NOT EXISTS embedding_queue_document_idx
  ON embedding_queue (document_id, embedding_version DESC)
  WHERE outcome IS NULL;

-- INDEX 3: For pruning old completed jobs
CREATE INDEX IF NOT EXISTS embedding_queue_archive_idx
  ON embedding_queue (created_at)
  WHERE outcome IS NOT NULL;
