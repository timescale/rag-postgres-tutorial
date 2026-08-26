-- On UPDATE: stamp updated_at, and if content changed, null embedding + increment version.
-- This marks the embedding as stale so the worker knows to re-embed.
-- Version guard prevents stale vectors from being written if content changes mid-embedding.

CREATE OR REPLACE FUNCTION documents_before_update() RETURNS trigger AS $$
BEGIN
  -- 1. Update the modified timestamp
  new.updated_at := now();

  -- 2. If content (searchable text) changed, invalidate the embedding
  --    This signals to the worker: "re-embed this document"
  IF old.content <> new.content THEN
    new.embedding := NULL;  -- Null marks as "needs embedding"
    new.embedding_version := old.embedding_version + 1;  -- Version guard
  END IF;

  RETURN new;
END
$$ LANGUAGE plpgsql;

-- Install the trigger on all UPDATEs to documents
DROP TRIGGER IF EXISTS documents_before_update_trg ON documents;
CREATE TRIGGER documents_before_update_trg
  BEFORE UPDATE ON documents
  FOR EACH ROW
  EXECUTE FUNCTION documents_before_update();
