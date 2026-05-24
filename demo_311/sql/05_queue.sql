create table embedding_queue
( id                bigint        generated always as identity primary key
, document_id       uuid          not null references documents(id) on delete cascade
, embedding_version int           not null
, vt                timestamptz   not null default now()
, outcome           text          check (outcome is null or outcome in
                                         ('completed','failed','cancelled'))
, attempts          int           not null default 0
, max_attempts      int           not null default 3
, last_error        text
, created_at        timestamptz   not null default now()
);

create index embedding_queue_claim_idx
  on embedding_queue (vt)
  where outcome is null;

create index embedding_queue_document_idx
  on embedding_queue (document_id, embedding_version desc)
  where outcome is null;

create index embedding_queue_archive_idx
  on embedding_queue (created_at)
  where outcome is not null;

create function enqueue_embedding() returns trigger as $$
begin
  insert into embedding_queue (document_id, embedding_version)
  values (new.id, new.embedding_version);
  return new;
end
$$ language plpgsql;

create trigger documents_enqueue_on_insert
  after insert on documents
  for each row
  when (new.embedding is null)
  execute function enqueue_embedding();

create trigger documents_enqueue_on_update
  after update on documents
  for each row
  when (old.content is distinct from new.content
        and new.embedding is null)
  execute function enqueue_embedding();
