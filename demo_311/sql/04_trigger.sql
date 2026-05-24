create function documents_before_update() returns trigger as $$
begin
  new.updated_at := now();

  if old.content <> new.content then
    new.embedding := null;
    new.embedding_version := old.embedding_version + 1;
  end if;

  return new;
end
$$ language plpgsql;

create trigger documents_before_update_trg
  before update on documents
  for each row execute function documents_before_update();
