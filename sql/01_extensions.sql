-- Install extensions for vector search, hierarchies, geospatial, and full-text indexing

CREATE EXTENSION IF NOT EXISTS vector;        -- Vector embeddings + HNSW indexing
CREATE EXTENSION IF NOT EXISTS ltree;         -- Hierarchical paths (org.team.project)
CREATE EXTENSION IF NOT EXISTS postgis;       -- Geospatial queries
CREATE EXTENSION IF NOT EXISTS pg_textsearch; -- BM25 full-text search
