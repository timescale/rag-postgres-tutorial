-- JSONB attribute lookups: meta @> '{"agency":"NYPD"}'
create index documents_meta_gin_idx
  on documents using gin (meta);

-- Hierarchical path queries: tree <@ 'nyc.brooklyn'
create index documents_tree_gist_idx
  on documents using gist (tree);

-- Range overlap & containment: temporal @> now() or temporal && range
create index documents_temporal_gist_idx
  on documents using gist (temporal)
  where temporal is not null;

-- Geospatial: ST_DWithin, ST_Intersects, <-> (kNN)
create index documents_geom_gist_idx
  on documents using gist (geom)
  where geom is not null;

-- BM25 full-text: content <@> to_bm25query(...)
create index documents_content_bm25_idx
  on documents using bm25 (content)
  with (text_config = 'english', k1 = 1.2, b = 0.75);

-- Vector similarity: embedding <=> query::halfvec
create index documents_embedding_hnsw_idx
  on documents using hnsw (embedding halfvec_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Partial index for the worker to find rows that still need embeddings
create index documents_pending_embedding_idx
  on documents (created_at)
  where embedding is null;
