# demo_311 — NYC 311 as a single-table RAG corpus

A worked example of [blog_rag_tutorial.md](../blog_rag_tutorial.md) applied to the [NYC 311 Service Requests](https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-Present/erm2-nwe9) open dataset. The schema, queue, worker, search, and MCP server are all taken from the tutorial; this directory is the testbed used to validate them and catch bugs (see [TUTORIAL_ISSUES.md](TUTORIAL_ISSUES.md)).

## Dataset shape

Each 311 service request is one `documents` row:

| Schema column | What it holds                                                                     |
|---------------|-----------------------------------------------------------------------------------|
| `content`     | Natural-language description: complaint, descriptor, address, agency, resolution. |
| `meta`        | Structured fields: `agency`, `status`, `borough`, `complaint_type`, `incident_zip`, … |
| `tree`        | `nyc.<borough>.<agency>.<complaint_type>` (e.g. `nyc.brooklyn.dot.street_condition`). |
| `temporal`    | `[created_date, closed_date)`, or `[created_date, created_date]` if still open.   |
| `geom`        | `ST_SetSRID(ST_MakePoint(lon, lat), 4326)`.                                       |
| `embedding`   | Filled in asynchronously by the worker (text-embedding-3-small, 1536 dims).       |

## Layout

```
demo_311/
├── sql/                       — schema/queue/triggers/claim function, runnable in order
│   ├── 01_extensions.sql
│   ├── 02_schema.sql
│   ├── 03_indexes.sql
│   ├── 04_trigger.sql
│   ├── 05_queue.sql
│   ├── 06_enqueue_trigger.sql
│   └── 07_claim_function.sql
├── src/
│   ├── env.ts                 — load .env (this dir, then repo root)
│   ├── load.ts                — fetch from Socrata, insert into documents
│   ├── worker.ts              — drains embedding_queue via claim_embedding_batch
│   ├── search.ts              — searchDocuments + the 6 mode helpers
│   ├── search-cli.ts          — exercises all 7 modes against the loaded data
│   └── mcp-server.ts          — agent-facing MCP wrapper
├── package.json
├── tsconfig.json
└── TUTORIAL_ISSUES.md         — bugs / gotchas in the tutorial caught while building this
```

## Running

```sh
# 1. Set env (DATABASE_URL, OPENAI_API_KEY)
cp .env.example .env && $EDITOR .env

# 2. Apply schema (assumes pg_textsearch, pgvector, postgis, ltree are installed)
for f in sql/*.sql; do psql "$DATABASE_URL" -f "$f"; done

# 3. Install deps
npm install

# 4. Load 10k rows (default; override with LOAD_LIMIT)
LOAD_LIMIT=10000 npm run load

# 5. Embed (runs until queue is drained, then exits)
EXIT_WHEN_DONE=1 BATCH_SIZE=256 npm run worker

# 6. Test all 7 modes
npm run search

# 7. Run MCP server (stdio) — wire into Claude/Cursor config
npm run mcp
```

## What gets tested

`src/search-cli.ts` exercises every mode in the tutorial plus a composition example:

1. **BM25** — `"pothole brooklyn"`
2. **Semantic** — `"loud music keeping me up at night"`
3. **Hybrid (RRF)** — `"abandoned car on the street"`
4. **Hierarchical** — `tree <@ 'nyc.brooklyn.dot'`
5. **Temporal** — last 24h window
6. **Geospatial** — 1km around Times Square (`<->` kNN ordering)
7. **Metadata** — `{"agency":"NYPD","status":"In Progress"}`
8. **Composition** — hybrid + ltree + geo filter, in a single query
