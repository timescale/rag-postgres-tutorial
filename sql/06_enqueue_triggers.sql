-- Automatically enqueue jobs when: document inserted with embedding=NULL, or content updated.
-- WHEN clause ensures we only enqueue when embedding is NULL (not for already-embedded docs).

CREATE OR REPLACE FUNCTION enqueue_embedding() RETURNS trigger AS $$
BEGIN
  INSERT INTO embedding_queue (document_id, embedding_version)
  VALUES (new.id, new.embedding_version);
  RETURN new;
END
$$ LANGUAGE plpgsql;

-- On INSERT: enqueue if embedding is NULL
DROP TRIGGER IF EXISTS documents_enqueue_on_insert ON documents;
CREATE TRIGGER documents_enqueue_on_insert
  AFTER INSERT ON documents
  FOR EACH ROW
  WHEN (new.embedding IS NULL)
  EXECUTE FUNCTION enqueue_embedding();

-- On UPDATE: enqueue only if content changed (detected by before-update trigger nulling embedding)
DROP TRIGGER IF EXISTS documents_enqueue_on_update ON documents;
CREATE TRIGGER documents_enqueue_on_update
  AFTER UPDATE ON documents
  FOR EACH ROW
  WHEN (old.content IS DISTINCT FROM new.content AND new.embedding IS NULL)
  EXECUTE FUNCTION enqueue_embedding();
