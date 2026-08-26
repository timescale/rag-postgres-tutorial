create or replace function prune_embedding_queue(retention interval default '7 days')
returns bigint
language plpgsql as $$
declare
  pruned bigint;
begin
  delete from embedding_queue
  where outcome is not null
    and created_at < now() - retention;
  get diagnostics pruned = row_count;
  return pruned;
end
$$;
