# demo_311 — exercising the RAG tutorial against NYC 311

This folder rebuilds the schema/worker/search stack from `../blog_rag_tutorial.md`
against a Ghost-hosted Postgres, loaded with 2000 recent NYC 311 service requests.
It exists to flush out bugs in the tutorial code and to measure how the embedding
worker actually behaves end-to-end.

## Layout

```
sql/              one file per step from the tutorial
  01_extensions.sql       extensions: vector, ltree, postgis, pg_textsearch
  02_schema.sql           documents table + check constraints
  03_indexes.sql          GIN / GiST / BM25 / HNSW / partial pending index
  04_before_update_trigger.sql   invalidate embedding on content change
  05_queue.sql            embedding_queue table + indexes
  06_enqueue_trigger.sql  insert/update triggers that enqueue jobs
  07_claim_function.sql   claim_embedding_batch()

src/
  ingest.ts        loads data/nyc311.json into documents (bulk-insert via unnest)
  worker.ts        the embedding worker (run with --bench to measure throughput)
  search.ts        searchDocuments() with all seven modes
  search-cli.ts    smoke tests covering all nine search-mode combinations
  mcp-server.ts    stdio MCP server exposing documents_search

data/nyc311.json   2000 newest 311 records from data.cityofnewyork.us
```

## How the corpus is shaped to the schema

- `content`: `"Complaint: ... / Descriptor: ... / Address: ... / Agency: ... / Status: ... / Resolution: ..."`
- `meta`: `{ agency, complaint_type, descriptor, status, borough, zip, channel, location_type, unique_key, type }`
- `tree`: `nyc.<borough>.<agency>.<complaint_type>` (labels lowercased, non-alnum collapsed to `_`)
- `temporal`:
  - closed ticket → `[created_date, closed_date)`
  - open ticket → `[created_date, created_date]` (the point-in-time form the
    `temporal_bounds_convention` check requires)
- `geom`: `ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)`, NULL when the
  record has no coordinates (~3% of rows).

## Reproducing the run

```
npm install
node -e "console.log('have OPENAI_API_KEY:', !!process.env.OPENAI_API_KEY)" # ensure .env is loaded
./node_modules/.bin/tsx src/ingest.ts        # ~8s for 2000 rows
./node_modules/.bin/tsx src/worker.ts --bench # drains the embedding queue then exits
./node_modules/.bin/tsx src/search-cli.ts    # nine search-mode smoke tests
```

## Worker timing (2000 rows, single worker, Ghost cloud DB)

- Total: **142.76 s** = **14.0 rows/s** end-to-end
- Per batch (size 64): typically `embed=500–1800 ms`, `write=1500–4000 ms`,
  total `2500–6500 ms` per batch
- Write time dominates after the first few batches — HNSW maintenance on each
  bulk update is the main cost, plus ~50–80 ms RTT to the cloud DB
- Embed call itself averaged ~1.1 s for 64 inputs against
  `text-embedding-3-small` — well under the OpenAI per-request rate limit

Throughput is acceptable but well below what a colocated worker would get;
the network round-trip to Ghost (cepwyfo8pl.tsdb.cloud.timescale.com) is the
single biggest contributor. Running multiple workers in parallel would scale
this linearly, since `SELECT FOR UPDATE SKIP LOCKED` partitions cleanly.

## Tutorial issues found

These are the spots where the blog's snippets are wrong, incomplete, or
ambiguous. Each one cost time to debug.

1. **The blog's "use `sql.json` rather than `JSON.stringify`" warning is
   correct, but the warning is buried in a comment and easy to miss.**
   I hit this directly: writing `meta @> ${JSON.stringify(p.meta)}::jsonb`
   compiles, runs, and silently returns zero hits — because postgres.js sends
   the stringified JSON as a text parameter, and `text::jsonb` produces a JSON
   *scalar string*, which `@>` on an object never matches. The blog could
   make this trap louder; it's the kind of bug that hides in production for
   weeks.

2. **The worker writeback snippet has a subtle integer-precision footgun
   that the surrounding comment only half-addresses.**
   The comment notes that postgres.js encodes `bigint` as a JS *string* to
   avoid precision loss. The snippet then passes `queueIds` (strings) through
   `::bigint[]`. Fine. But the snippet still types the local variable as
   `bigint`-shaped; readers copy-pasting into TypeScript with strict types
   get unexpected `string | number` unions. Worth a one-line callout.

3. **No working `import postgres from 'postgres'` example covers the
   `debug` callback signature.**
   When trying to inspect generated SQL, you reach for `postgres(url, { debug })`,
   but the blog never shows it and the callback signature (`(connection, query, params, types) => void`)
   isn't obvious. Minor, but slows down anyone trying to debug the very
   issues called out above.

4. **The MCP "all inputs are optional and nullable" advice produces noisy
   types.** `z.string().optional().nullable()` yields `string | null | undefined`,
   so every handler does `args.foo ?? undefined` unwrapping. For nested
   objects like `temporal: { from, to }`, you have to unwrap twice (the
   outer object and the inner fields). The blog calls this out in a comment
   on `temporal`, but not on `near`. Easy to miss.

5. **The temporal convention is hard to satisfy for open-ended events.**
   The `temporal_bounds_convention` CHECK constraint accepts either a
   point `[t,t]` or a half-open range `[start,end)`. An open 311 ticket
   doesn't have an end time, so I chose `[created_date, created_date]`.
   That works for `@>` (contains the instant) but it doesn't *overlap* a
   window that starts after `created_date`, which can be surprising. The
   tutorial doesn't discuss this trade-off; for live-state corpora you
   probably want an "open-ended" representation (`[start, infinity)`),
   which the current check constraint *forbids*. Mentioned in the schema
   comment in `sql/02_schema.sql`.

## Notes

- All seven search modes from the tutorial work, plus the filter-only
  fast path and the hybrid+filter composition. See `src/search-cli.ts`
  output for nine end-to-end checks.
- The MCP server starts cleanly under stdio and answers `initialize`. I
  did not wire it into a Claude config; this lab focuses on the
  retrieval layer.
- Ghost CLI on this machine is one minor version behind (0.14.1 →
  0.15.0); upgrading isn't required to run the demo, but it's the
  reason for the warning at the top of every Ghost MCP session.
