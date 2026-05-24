# demo_311 — NYC 311 RAG, built per `blog_rag_tutorial.md`

Walks the tutorial end-to-end against ~2000 NYC 311 Service Requests on a
Ghost-managed Postgres. Used to validate the tutorial code; see
[TUTORIAL_NOTES.md](TUTORIAL_NOTES.md) for what broke and what didn't.

## Layout

- [sql/](sql/) — schema, indexes, triggers, queue, claim function. Run in
  numeric order.
- [src/fetch-311.ts](src/fetch-311.ts) — pulls 2000 recent 311 rows from the
  NYC Open Data Socrata endpoint into `data/raw.jsonl`.
- [src/load-copy.ts](src/load-copy.ts) — bulk-loads via `COPY ... FROM
  STDIN` (the natural answer; sidesteps the jsonb trap entirely).
- [src/load.ts](src/load.ts) — alternative parametrized bulk insert using
  `jsonb_array_elements`. Kept for the writeup comparison.
- [src/worker.ts](src/worker.ts) — embedding worker with per-batch timing.
- [src/search.ts](src/search.ts) — `searchDocuments`, lifted from Step 6h of
  the tutorial.
- [src/search-cli.ts](src/search-cli.ts) — exercises all seven modes plus
  three composition examples.
- [src/mcp-server.ts](src/mcp-server.ts) — stdio MCP server exposing
  `documents_search`.
- [src/mcp-smoketest.ts](src/mcp-smoketest.ts) — spawns the MCP server and
  verifies `tools/list` + `tools/call`.

## Reproducing

```bash
# 1. Provision (Ghost MCP, or `ghost create demo-311`)
# 2. .env with DATABASE_URL and OPENAI_API_KEY
# 3. Apply schema
for f in sql/*.sql; do psql "$DATABASE_URL" -f "$f"; done

# 4. Fetch + load
npm install
npm run fetch         # ~3s, writes data/raw.jsonl
npm run load          # ~6s, COPY 2000 rows; enqueues 2000 embedding jobs
# npm run load:insert # alternative parametrized INSERT path (~9s)

# 5. Embed (one-shot — worker exits when the queue drains)
npm run worker  # ~2 minutes for 2000 rows on text-embedding-3-small

# 6. Search
npm run search  # prints results from all 7 modes + composition

# 7. MCP
npm run mcp                # serves on stdio
node_modules/.bin/tsx src/mcp-smoketest.ts  # in-band sanity check
```

## Performance snapshot

2000 rows, BATCH=64, single worker, Tiger Cloud, ~40ms RTT:

| stage | total | avg/batch | share |
| ----- | ----- | --------- | ----- |
| claim | 12.3s | 383ms     | 10%   |
| embed | 31.0s | 969ms     | 25%   |
| write | 74.9s | 2341ms    | 61%   |
| **total** | **121.9s** | — | 16.4 rows/s |

HNSW index upserts on the write side are the floor; multi-worker
`SKIP LOCKED` parallelism is the way to push past it.
