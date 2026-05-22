-- Before-update trigger — verbatim from the tutorial
create function documents_before_update() returns trigger as $$
begin
  new.updated_at := now();

  -- Content changed: invalidate embedding and bump version
  if old.content is distinct from new.content
     and old.embedding is not distinct from new.embedding
  then
    new.embedding := null;
    new.embedding_version := old.embedding_version + 1;
    new.embedding_attempts := 0;
    new.embedding_last_error := null;
  end if;

  -- Worker writing the embedding back: clear error state
  if new.embedding is not null and old.embedding is distinct from new.embedding then
    new.embedding_attempts := 0;
    new.embedding_last_error := null;
  end if;

  return new;
end
$$ language plpgsql;

create trigger documents_before_update_trg
  before update on documents
  for each row execute function documents_before_update();
