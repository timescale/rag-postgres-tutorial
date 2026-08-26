-- One index per search mode. Drop the ones you don't use.

-- METADATA: GIN index for @> (containment) queries
CREATE INDEX IF NOT EXISTS documents_meta_gin_idx
  ON documents USING gin (meta);

-- HIERARCHY: GiST index for <@ (ancestor/descendant) queries
CREATE INDEX IF NOT EXISTS documents_tree_gist_idx
  ON documents USING gist (tree);

-- TEMPORAL: GiST index for && (overlap) range queries
CREATE INDEX IF NOT EXISTS documents_temporal_gist_idx
  ON documents USING gist (temporal)
  WHERE temporal IS NOT NULL;

-- GEOGRAPHIC: GiST index for ST_DWithin, ST_Intersects, <-> queries
CREATE INDEX IF NOT EXISTS documents_geom_gist_idx
  ON documents USING gist (geom)
  WHERE geom IS NOT NULL;

-- BM25 FULL-TEXT: BM25 ranking for keyword search
CREATE INDEX IF NOT EXISTS documents_content_bm25_idx
  ON documents USING bm25 (content)
  WITH (text_config = 'english', k1 = 1.2, b = 0.75);

-- VECTOR: HNSW index for <=> (nearest neighbor) search
CREATE INDEX IF NOT EXISTS documents_embedding_hnsw_idx
  ON documents USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);
