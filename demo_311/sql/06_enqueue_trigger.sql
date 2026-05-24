-- Enqueue an embedding job whenever a row is inserted without an embedding,
-- or whenever content changes (and the before-update trigger nulled the embedding).
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
