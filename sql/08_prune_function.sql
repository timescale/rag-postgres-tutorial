-- Delete old completed/failed/cancelled jobs (audit trail after retention period).
-- Run weekly via cron: 0 2 * * 0 psql ... -c "SELECT prune_embedding_queue();"
-- Returns: number of rows deleted.

CREATE OR REPLACE FUNCTION prune_embedding_queue(retention interval DEFAULT '7 days')
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  pruned bigint;
BEGIN
  DELETE FROM embedding_queue
  WHERE outcome IS NOT NULL
    AND created_at < now() - retention;
  GET DIAGNOSTICS pruned = ROW_COUNT;
  RETURN pruned;
END
$$;
