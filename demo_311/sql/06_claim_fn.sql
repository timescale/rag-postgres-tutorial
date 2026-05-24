create function claim_embedding_batch(
  batch_size    int      default 10,
  lock_duration interval default '5 minutes'
)
returns table (queue_id bigint, document_id uuid, embedding_version int, content text)
language plpgsql as $$
declare
  rec record;
  doc record;
  claimed int := 0;
begin
  -- 1. Bulk-cancel jobs superseded by a newer version for the same document
  update embedding_queue eq
    set outcome = 'cancelled'
    where eq.outcome is null
      and eq.vt <= now()
      and exists (
        select 1 from embedding_queue newer
        where newer.document_id = eq.document_id
          and newer.embedding_version > eq.embedding_version
          and newer.outcome is null
      );

  -- 2. Reap jobs orphaned by crashed workers
  update embedding_queue
    set outcome = 'failed',
        last_error = coalesce(last_error, 'exceeded max attempts (worker crash)')
    where outcome is null and vt <= now() and attempts >= max_attempts;

  -- 3. Claim eligible rows, FOR UPDATE SKIP LOCKED
  for rec in
    select eq.id, eq.document_id, eq.embedding_version
    from embedding_queue eq
    where eq.outcome is null
      and eq.vt <= now()
      and eq.attempts < eq.max_attempts
    order by eq.vt
    for update skip locked
  loop
    select d.content, d.embedding_version into doc
    from documents d where d.id = rec.document_id;

    if not found then
      update embedding_queue set outcome = 'cancelled' where id = rec.id;
      continue;
    end if;

    if rec.embedding_version <> doc.embedding_version then
      update embedding_queue set outcome = 'cancelled' where id = rec.id;
      continue;
    end if;

    update embedding_queue
      set vt = now() + lock_duration,
          attempts = embedding_queue.attempts + 1
      where id = rec.id;

    queue_id          := rec.id;
    document_id       := rec.document_id;
    embedding_version := rec.embedding_version;
    content           := doc.content;
    return next;

    claimed := claimed + 1;
    exit when claimed >= batch_size;
  end loop;
end
$$;
