-- Pre-load: only the GIN/GiST indexes (cheap to build incrementally).
-- BM25 and HNSW are deferred until after bulk load and embedding (see 07_indexes_post_load.sql).
create index documents_meta_gin_idx
  on documents using gin (meta);

create index documents_tree_gist_idx
  on documents using gist (tree);

create index documents_temporal_gist_idx
  on documents using gist (temporal)
  where temporal is not null;

create index documents_geom_gist_idx
  on documents using gist (geom)
  where geom is not null;
