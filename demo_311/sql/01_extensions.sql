-- Required extensions from the tutorial
create extension if not exists vector;        -- pgvector: halfvec, HNSW
create extension if not exists ltree;         -- hierarchical paths
create extension if not exists postgis;       -- geospatial types and indexes
create extension if not exists pg_textsearch; -- BM25 (tutorial says pg_search, but ghost.build ships pg_textsearch)
