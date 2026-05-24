-- Transactional outbox queue for embedding generation.
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
