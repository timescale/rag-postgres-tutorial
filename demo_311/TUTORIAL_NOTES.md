# Tutorial validation notes

Built `demo_311` against `blog_rag_tutorial.md` using NYC 311 Service Requests
loaded into a Ghost-managed Postgres (`demo-311`, id `nuc5nt8ba7`). 2000 rows,
all seven search modes exercised end-to-end. Below is what passed unmodified
and what didn't.

## What worked, verbatim from the post

- All SQL in Steps 1–4 (extensions, schema, indexes, trigger, queue table,
  enqueue trigger, `claim_embedding_batch`) compiled and ran on Ghost Postgres
  18 with `pg_textsearch` available. Zero edits.
- The worker writeback (Step 5) — the `with input as (... unnest(...)) ...`
  CTE that updates `documents` and then updates `embedding_queue` — ran as
  written.
- Step 6h `searchDocuments`, including `buildFilters`, `metersProj`,
  `fetchByIds`, and `rrfFusion`, ran with no edits and produced sensible
  results across all seven modes plus the composition examples.
- The Step 7 MCP server (`registerTool('documents_search', ...)`) boots over
  stdio and returns rows; `tools/list` and `tools/call` both succeed.

## Gaps / broken bits

### 1. No bulk-insert pattern for the `documents` table

The post shows `unnest(${ids}::uuid[], ${versions}::int[], ${queueIds}::bigint[], ${vecs}::text[])`
in the worker writeback but never shows how to *insert* rows in bulk. The
obvious extension — add `${metas.map(JSON.stringify)}::jsonb[]` — silently
stores each element as a JSON scalar string rather than an object:

```
detail: 'Failing row contains (..., "{\"unique_key\":\"69083205\",...", ...).',
constraint_name: 'documents_meta_check'  -- jsonb_typeof(meta) = 'object'
```

The `jsonb_typeof = 'object'` check in Step 1 catches this; the post even
warns about it for *query* parameters (the `jsonb` helper in
`buildFilters`). But it doesn't show a working bulk-insert.

**The natural answer is `COPY`.** It parses each field as the column's input
type, so jsonb `{"a":1}` becomes an object, geometry `SRID=4326;POINT(...)`
becomes a point, and `tstzrange` literals parse as ranges — no `text[]::T[]`
double-cast and no scalar-string trap. See [src/load-copy.ts](src/load-copy.ts):

```ts
const writable = await sql`
  copy documents (content, meta, tree, temporal, geom) from stdin
`.writable();
await pipeline(Readable.from([payload]), writable);
```

Timings on this dataset (2000 rows):

- Batched INSERT with `jsonb_array_elements` workaround: **8.5s**
- COPY (text format): **5.8s** (~30% faster, and streams cleanly to millions)

For batches that genuinely need to be parametrized in SQL — say,
upserts where you want `on conflict` server-side — the
`jsonb_array_elements(${sql.json(values)}::jsonb)` pattern in
[src/load.ts](src/load.ts) still works and avoids the trap.

Either way: a one-paragraph sidebar in the post saying "for bulk loads, use
COPY; for parametrized bulk inserts, fan out one jsonb argument server-side
— never `JSON.stringify(meta)::jsonb`" would close the gap.

### 2. Worker main-loop is one-shot-unfriendly *(now addressed in the post)*

[blog_rag_tutorial.md:415-422](blog_rag_tutorial.md#L415-L422) shows the
worker loop as `while(true) { processBatch(); sleep(10s) on empty }`. That's
right for production but means the demo-style "backfill 2000 rows then exit"
needs extra code; mine in [src/worker.ts:80-93](src/worker.ts#L80-L93)
tracks `idleSince` and exits after 5s of silence. Resolved by appending a
sentence to the "Adaptive polling" bullet in Step 5: "for one-shot
backfills, swap the `sleep` for a `break` after a few consecutive empty
polls."

### 3. ltree label sanitization is mentioned but not shown *(now addressed in the post)*

[blog_rag_tutorial.md:91](blog_rag_tutorial.md#L91) used to say "sanitize
at write time" without showing how. Resolved by inlining the regex on the
ltree bullet: `s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')`
turns `"Noise - Residential"` into `noise_residential`.

### 4. Hardcoded BM25 index name

The BM25 query is `to_bm25query($1, 'documents_content_bm25_idx')`. The
literal index name is fragile (rename the index and every query breaks
silently — well, with a runtime error). Not a tutorial bug, but worth
calling out that this string and the `create index` name are coupled.

## Performance — embedding worker

2000 NYC 311 rows, single worker, BATCH=64, `text-embedding-3-small`,
Ghost (Tiger Cloud) with ~40 ms RTT from my laptop:

```
done: 2000 rows in 121.9s (16.4 rows/s)
  claim:  12.25s total, avg 383ms/batch
  embed:  31.02s total, avg 969ms/batch
  write:  74.90s total, avg 2341ms/batch
```

- **Write (61% of time) dominates because of the HNSW index.** Each batch of
  64 inserts triggers 64 HNSW upserts; at `m=16, ef_construction=64` that's
  ~36 ms per row on this DB. Bumping `ef_construction` for better recall
  will make this worse linearly.
- **Embed (25%)** is the OpenAI roundtrip + the SDK's internal retry budget,
  about a second per batch of 64. Roughly what you'd expect.
- **Claim (10%)** is mostly TLS RTT on an empty function call; the actual
  PL/pgSQL work is sub-ms.

So "is the worker too slow?" — at 16 rows/s a single worker would take
~17 hours per million rows. That's the floor with one process. The
tutorial's note about multi-worker `SKIP LOCKED` scaling is the right
escape hatch: 4 parallel workers should push you to ~50-60 rows/s before
the DB write path becomes the bottleneck.

## Bottom line

The tutorial code base is correct as written — every snippet I copied
verbatim ran. The only real *gap* is that the bulk-insert path isn't
shown, and the natural generalization of the writeback's `unnest` pattern
hits the same jsonb-as-scalar-string bug the post warns about elsewhere.
Adding a sidebar with the `jsonb_array_elements` pattern would close that.
