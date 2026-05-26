-- Post-load: BM25 and HNSW indexes, built once on the populated table.
create index documents_content_bm25_idx
  on documents using bm25 (content)
  with (text_config = 'english', k1 = 1.2, b = 0.75);

create index documents_embedding_hnsw_idx
  on documents using hnsw (embedding halfvec_cosine_ops)
  with (m = 16, ef_construction = 64);
