# Build a Production-Ready RAG System with Postgres 🚀

A complete tutorial for building a powerful retrieval-augmented generation (RAG) system using **only PostgreSQL**. No external vector stores, search engines, or sync nightmares.

## What You'll Build

A production-ready retrieval layer that supports:

- **BM25 Full-Text Search** — Keyword ranking that actually works
- **Vector Semantic Search** — HNSW-indexed embeddings for "the vibe"
- **Hybrid Search** — Best of both worlds with Reciprocal Rank Fusion
- **Hierarchical Filtering** — Path-based queries (`work.projects.acme.notes`)
- **Temporal Filtering** — Time-bounded search
- **Geospatial Queries** — Find nearby documents
- **Metadata Filtering** — JSONB attribute lookups
- **Async Embedding** — Transactional outbox + crash recovery
- **Multi-Worker Coordination** — Zero-overhead worker fleet
- **AI Agent Access** — Expose search via MCP

## Why One Postgres Table?

Most RAG stacks scatter data everywhere:

```
Postgres → Vector DB → Search Engine → Job Queue → 3x billing
```

This creates:
- ❌ Data sync problems (missing one transaction = broken retrieval)
- ❌ Lost filters (filter in vector DB, lose recall)
- ❌ Double billing (store data twice + engineering overhead)

**One table means:**
- ✅ One source of truth
- ✅ Consistent filtering (all filters apply before ranking)
- ✅ No sync code
- ✅ Lower operational overhead

## Prerequisites

- **Database:** Tiger Cloud, self-hosted Postgres 15+, or TimescaleDB (with `vector`, `ltree`, `postgis`, `pg_textsearch` extensions)
- **Node.js 20+** — For worker and search code
- **OpenAI API key** — For embeddings (`text-embedding-3-small`)

## Quick Start

### 1. Set Up Database

**Tiger Cloud** (recommended):
```bash
psql "postgresql://user:password@host:5432/tsdb"
\dx  # verify: vector, ltree, postgis, pg_textsearch
```

**Self-hosted Postgres:**
```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_textsearch;
```

### 2. Configure

```bash
cp .env.example .env
# Fill in DATABASE_URL and OPENAI_API_KEY
```

### 3. Initialize Schema

```bash
cat sql/*.sql | psql $DATABASE_URL
```

Or individually:
```bash
psql -d $DATABASE_URL -f sql/01_extensions.sql
psql -d $DATABASE_URL -f sql/02_schema.sql
# ... etc
```

### 4. Load Data

```bash
npm install
npm run load
```

You'll see 1,000 NYC 311 Service Requests loaded with automatic embedding queue setup.

### 5. Start Worker

In a new terminal:
```bash
npm run worker
```

Worker claims batches of 128 docs, generates embeddings, writes them back. Leave it running.

### 6. Test Search

In another terminal:
```bash
npm run search
```

See pre-configured search examples. Edit `src/search-cli.ts` to try your own.

## Project Structure

```
sql/                 # Database setup (run 01 → 08)
├── 01_extensions.sql
├── 02_schema.sql     # documents table with 7 search modes
├── 03_indexes.sql    # One index per mode
├── 04_before_update_trigger.sql
├── 05_queue_table.sql  # Transactional outbox
├── 06_enqueue_triggers.sql
├── 07_claim_function.sql  # Core worker function
└── 08_prune_function.sql

src/
├── load.ts           # Batch loader
├── worker.ts         # Embedding worker
├── search.ts         # Search implementation
├── search-cli.ts     # CLI for testing
└── mcp-server.ts     # Expose to AI agents

data/
└── nyc311_1000.json  # Sample data
```

## How It Works

### The Documents Table

| Column | Type | Purpose |
|--------|------|---------|
| `id` | `uuid` | UUIDv7 (timestamp-ordered) |
| `content` | `text` | Searchable text |
| `meta` | `jsonb` | Attributes (status, type, etc.) |
| `tree` | `ltree` | Hierarchy (`org.team.project`) |
| `temporal` | `tstzrange` | Time range |
| `geom` | `geometry(Point, 4326)` | Location (lat/lon) |
| `embedding` | `halfvec(1536)` | Vector (async-filled) |
| `embedding_version` | `int` | Race condition guard |

### The Queue Pattern

When you insert/update a document:
1. `before_update` trigger marks embedding as stale (if content changed)
2. `after_insert/update` trigger creates a queue job
3. Worker claims jobs with `FOR UPDATE SKIP LOCKED` (no blocking!)
4. Worker generates embedding, writes back with version check
5. Multiple workers coordinate with zero overhead

If a worker crashes, the job becomes visible again after the lock timeout. Simple, bulletproof.

## Search Modes

### BM25 Full-Text
```typescript
await searchDocuments({ fulltext: "missing sidewalk" });
```

### Vector Semantic
```typescript
await searchDocuments({ semantic: "infrastructure complaints" });
```

### Hybrid (BM25 + Vector)
```typescript
await searchDocuments({ 
  fulltext: "missing sidewalk", 
  semantic: "missing sidewalk" 
});
```

### With Filters
```typescript
await searchDocuments({
  fulltext: "pothole",
  tree: "nyc.brooklyn",                    // Hierarchy
  meta: { status: "OPEN", agency: "DOT" },// Metadata
  temporal: {                              // Time range
    from: "2024-01-01", 
    to: "2024-06-30" 
  },
  near: {                                  // Geospatial
    lon: -73.9857, 
    lat: 40.7829, 
    radiusMeters: 5000 
  }
});
```

All filters compose in a single query. No post-filtering.

## Customizing for Your Data

### 1. Update the Loader (`src/load.ts`)

```typescript
interface Row {
  id: string;
  text: string;
  author: string;
  // your fields
}

function buildContent(r: Row): string {
  return `${r.text} by ${r.author}`;
}

function rowToCols(r: Row, c: Cols, seen: Set<string>): void {
  c.metas.push({ author: r.author });
  c.trees.push(`docs.${r.author}`);
  // populate temporal, geom, etc.
}
```

### 2. Drop Unused Columns

```sql
DROP INDEX documents_tree_gist_idx;
ALTER TABLE documents DROP COLUMN tree;
```

### 3. Tune Indexes

**BM25** (`03_indexes.sql`):
```sql
CREATE INDEX documents_content_bm25_idx
  ON documents USING bm25 (content)
  WITH (text_config = 'english', k1 = 1.2, b = 0.75);
```
- `k1`: Reward term frequency (1.2 = default, 2.0 = aggressive)
- `b`: Penalize long documents (0.75 = default, 0.0 = none)

**HNSW** (`03_indexes.sql`):
```sql
CREATE INDEX documents_embedding_hnsw_idx
  ON documents USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```
- `m`: Edges per node (higher = better recall, slower inserts)
- `ef_construction`: Search breadth during build (64 is fine for ~1M docs)

## Common Patterns

### Upsert with Auto Re-embedding

```typescript
await sql`
  INSERT INTO documents (id, content, meta, tree)
  VALUES (${id}, ${content}, ${sql.json(meta)}, ${tree})
  ON CONFLICT (id) DO UPDATE SET
    content = EXCLUDED.content,
    meta = EXCLUDED.meta,
    tree = EXCLUDED.tree;
`;
// Triggers automatically handle embedding invalidation & re-queueing
```

### Bulk Upsert

```typescript
await sql`
  WITH input AS (
    SELECT * FROM unnest(
      ${ids}::uuid[],
      ${contents}::text[],
      ${metas.map(m => JSON.stringify(m))}::text[]::jsonb[]
    ) AS t(id, content, meta)
  )
  INSERT INTO documents (id, content, meta)
  SELECT * FROM input
  ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content;
`;
```

## Performance Tips

1. **Batch writes** — Use `BATCH = 200` in loader (larger = fewer roundtrips)
2. **Worker batch size** — Edit `src/worker.ts` (256–512 typical; OpenAI rate-limited)
3. **Half vectors** — Use `halfvec(1536)` not `vector(1536)` (50% storage, same recall)
4. **Multi-worker** — Run multiple workers; they coordinate via `FOR UPDATE SKIP LOCKED`
5. **Archive queue** — Run `SELECT prune_embedding_queue('7 days');` weekly
6. **Profile queries** — Use `EXPLAIN (ANALYZE, BUFFERS)`

## Troubleshooting

**"No results" from search:**
```sql
SELECT COUNT(*) FROM documents WHERE embedding IS NOT NULL;  -- Are docs embedded?
SELECT outcome, COUNT(*) FROM embedding_queue GROUP BY outcome;  -- Queue stuck?
```

**Worker crashes:**
```bash
grep OPENAI_API_KEY .env  # Verify key
```
```sql
SELECT document_id, last_error FROM embedding_queue WHERE outcome = 'failed';  -- Check errors
```

**Slow queries:**
```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT ... WHERE content <@> to_bm25query(...);
REINDEX INDEX documents_content_bm25_idx;  -- Rebuild if stale
```

## Deployment

- **Multi-region:** Use your DB provider's read replicas for search queries
- **Scaling 1B+ rows:** Consider partitioning by `tree` or hash(`id`)
- **Monitoring:** Alert on queue depth (`embedding_queue WHERE outcome IS NULL`), ingestion lag (`MAX(updated_at) FROM documents`)

## Next Steps

1. Customize `src/load.ts` for your data
2. Test search modes in `src/search-cli.ts`
3. Wire up MCP to expose search to Claude/Cursor
4. Deploy worker as a sidecar or scheduled task
5. Iterate on schema based on your query patterns

## References

- [pgvector](https://github.com/pgvector/pgvector)
- [Tiger Data BM25 Docs](https://docs.timescale.com/use-timescaledb/latest/search/bm25/)
- [ltree](https://www.postgresql.org/docs/current/ltree.html)
- [PostGIS](https://postgis.net/documentation/)
- [Reciprocal Rank Fusion](https://dl.acm.org/doi/10.1145/1571941.1572114)

## License

MIT
