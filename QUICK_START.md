# Quick Start: Get RAG Running in 10 Minutes

This is the fast track. For detailed explanations, see [README.md](README.md).

## 1. Set Up Database

### Tiger Cloud (Easiest)
```bash
# Visit: https://console.cloud.tigerdata.com/login
# Create service → Postgres 18+ → Your region → Create

# Copy connection string from dashboard
# In your terminal, test connection:
psql "postgresql://user:password@host:5432/tsdb"
```

### Self-Hosted Postgres
```bash
# Ensure extensions are installed:
psql postgresql://user:password@localhost:5432/mydb

# In psql:
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_textsearch;
```

## 2. Configure Environment

```bash
# Copy template
cp .env.example .env

# Edit .env with your values:
# DATABASE_URL=postgresql://user:password@host:5432/tsdb
# OPENAI_API_KEY=sk-proj-...
```

## 3. Set Up Schema

```bash
# Run all SQL files in order (8 files total, ~30 seconds)
cat sql/*.sql | psql "$DATABASE_URL"

# Or run individually:
psql "$DATABASE_URL" -f sql/01_extensions.sql
psql "$DATABASE_URL" -f sql/02_schema.sql
# ... etc
```

## 4. Install Dependencies

```bash
npm install
```

## 5. Load Sample Data

```bash
# Loads 1000 NYC 311 Service Requests into documents table
# Enqueues 1000 embedding jobs
npm run load

# Output:
# inserted 1000 / 1000
# embedding_queue (open): 1000
```

## 6. Start Worker (New Terminal)

```bash
# Runs in a loop, claiming 128 documents at a time
# Generates embeddings via OpenAI API
# Writes back to database
npm run worker

# Output:
# Claiming batch of 128 rows...
# Generated 128 embeddings (5.2s)
# Updated documents + queue (0.8s)
```

**Leave this running.** Embeddings take a few minutes (depends on batch size and rate limits).

## 7. Test Search (Another Terminal)

```bash
# Once worker has processed at least one batch:
npm run search

# Output:
# === Hybrid search: "missing sidewalk" ===
# Score: 0.82 | Sidewalk complaint filed 03/15/2022
# Score: 0.79 | Missing curb and sidewalk
# ...
```

## ✅ You're Done!

You now have a working RAG system with:
- ✅ 1000 documents in Postgres
- ✅ BM25 + vector search
- ✅ Automatic embedding generation
- ✅ Multi-worker scaling (try `npm run worker` in 3 terminals!)

## Next Steps

1. **Customize the loader** — Edit `src/load.ts` to ingest your data
2. **Test search modes** — Edit `src/search-cli.ts` to try different queries
3. **Wire up MCP** — Run `npm run mcp` to expose search to Claude/Cursor
4. **Read the detailed guide** — See [README.md](README.md) for architecture, tuning, and troubleshooting

## Useful Commands

```bash
# Check how many documents have embeddings:
psql "$DATABASE_URL" -c "SELECT COUNT(*) as total, COUNT(embedding) as with_embeddings FROM documents;"

# Check queue status:
psql "$DATABASE_URL" -c "SELECT outcome, COUNT(*) FROM embedding_queue GROUP BY outcome;"

# Search from CLI:
npm run search

# Run worker once (backfill mode):
npm run worker:oneshot

# Expose search via MCP:
npm run mcp

# See what went wrong:
psql "$DATABASE_URL" -c "SELECT id, last_error FROM embedding_queue WHERE outcome = 'failed';"
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `connection refused` | Check DATABASE_URL, network access, Postgres running |
| `permission denied` | Verify user has permissions (can you `\dt` in psql?) |
| Worker hangs | Check OpenAI API key, rate limits (https://platform.openai.com/account/usage) |
| No search results | Wait for worker to finish embeddings; check `COUNT(embedding)` query above |
| Slow loader | Use larger `BATCH` size in `src/load.ts` (default 200) |

See [README.md](README.md) **Troubleshooting** section for more help.
