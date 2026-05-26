# demo_311 — RAG-over-Postgres on NYC 311 Service Requests

End-to-end implementation of `blog_rag_tutorial.md` against the NYC 311 Service Requests dataset on a Ghost-managed Postgres.

## Layout

```
sql/                          # one statement-group per file, numbered in apply order
  01_extensions.sql           # vector, ltree, postgis, pg_textsearch
  02_schema.sql               # documents table + check constraints
  03_indexes_pre_load.sql     # GIN/GiST (cheap incrementally) — apply before bulk load
  04_triggers.sql             # before-update: invalidate embedding, bump version
  05_queue.sql                # embedding_queue + enqueue triggers
  06_claim.sql                # claim_embedding_batch + prune_embedding_queue
  07_indexes_post_load.sql    # BM25 + HNSW — build once after bulk load + embed
  03_indexes.sql              # combined (for reference; not used in the bulk-load flow)
src/
  fetch.ts                    # download N pages from data.cityofnewyork.us
  load.ts                     # one bulk INSERT … unnest per page
  worker.ts                   # claim → embed → version-guarded writeback
  search.ts                   # searchDocuments — all 7 modes + RRF fusion
  search-cli.ts               # exercises every mode against the loaded corpus
  mcp-server.ts               # stdio MCP server wrapping searchDocuments
data/                         # fetched pages (gitignored)
TUTORIAL_NOTES.md             # findings: what worked, what didn't compile, perf
```

## Running

```bash
npm install
# Apply SQL via Ghost MCP or psql, in this order:
#   01_extensions → 02_schema → 03_indexes_pre_load → 04_triggers → 05_queue → 06_claim
PAGES=2 npm run fetch         # ~2000 rows
npm run load
ONE_SHOT=1 BATCH_SIZE=64 npm run worker
# Then apply 07_indexes_post_load.sql (BM25 + HNSW on populated table).
npm run search                # demo all 7 search modes
```

`.env` needs `DATABASE_URL` and `OPENAI_API_KEY`.

## Mapping from 311 dataset to schema

| Column | Source |
|---|---|
| `content` | `complaint_type + descriptor + location_type + address + agency_name + status + resolution_description` joined by newlines |
| `meta` | `{ unique_key, agency, complaint_type, descriptor, status, borough, zip, location_type }` |
| `tree` | `nyc.<borough>.<agency>.<complaint_type>` (ltree-sanitized labels) |
| `temporal` | `[created_date, closed_date)` if closed, else `[created_date, infinity)` |
| `geom` | `ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)` |
