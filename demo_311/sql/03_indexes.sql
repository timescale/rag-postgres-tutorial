-- One index per search mode.
create index if not exists documents_meta_gin_idx
  on documents using gin (meta);

create index if not exists documents_tree_gist_idx
  on documents using gist (tree);

create index if not exists documents_temporal_gist_idx
  on documents using gist (temporal)
  where temporal is not null;

create index if not exists documents_geom_gist_idx
  on documents using gist (geom)
  where geom is not null;

create index if not exists documents_content_bm25_idx
  on documents using bm25 (content)
  with (text_config = 'english', k1 = 1.2, b = 0.75);

create index if not exists documents_embedding_hnsw_idx
  on documents using hnsw (embedding halfvec_cosine_ops)
  with (m = 16, ef_construction = 64);
