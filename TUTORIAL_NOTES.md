# `blog_rag_tutorial.md` — issues found while building demo_311

Built end-to-end against NYC 311 (1000 rows, latest day). All seven search modes
verified working (BM25, vector, hybrid RRF, ltree, temporal, geo, JSONB).
Everything below is what I had to figure out or work around — the **shipped
snippets in the post are correct as written** wherever I don't say otherwise.

## Worker timing (Step 5)

1000-row drain, single worker, default `BATCH = 128`, OpenAI
`text-embedding-3-small`, Ghost db with all indexes built (HNSW included):

```
batches:       8
rows:          1000
wall:          23.26s
throughput:    43.0 rows/s
avg claim:     309ms  / batch
avg embed:     934ms  / batch   (= 7ms/row — embedding API is the cheap part)
avg writeback: 1633ms / batch   (= 13ms/row — dominated by HNSW maintenance)
```

Not too slow — but the post's "Going further → bulk-loading an existing
corpus" note is well-earned: the writeback cost is HNSW upkeep, not the
embedding call. For >10k row backfills, drop the HNSW index, run the worker,
then rebuild.

First batch was ~2x slower than steady state (5113ms vs ~2400ms) — that's
the TLS handshake + cache warm-up on both ends. The post doesn't mention
this but it's normal and self-correcting.

## Code-level issues

### 1. Loader pattern was described but never shown — **fixed upstream**

Step 1's original inset was an abstract recommendation with no code, which
pushed the reader to invent the loader from prose. After a back-and-forth
on the right shape (and an empirical probe of how `postgres@3` serializes
arrays to `::jsonb[]`), the inset now contains a concrete `unnest(typed[]...)`
snippet plus annotated notes on the two casts that trip people up. The COPY
+ defer-indexes pattern got its own code sample in "Going further" since
it's a one-time-backfill concern rather than steady-state.

[src/load.ts](src/load.ts) tracks the recommended form (unnest + `::jsonb[]`
for `meta`, direct `::ltree[]` and `::tstzrange[]` for the path / range
columns — the driver escapes range and ltree array elements correctly, no
text+cast detour needed; verified empirically).

### 2. `temporal` constraint rejected degenerate ranges silently — **fixed upstream**

The original check constraint in Step 1:

```sql
or (lower(temporal) <  upper(temporal) and lower_inc(temporal) and not upper_inc(temporal))
```

required `lower < upper`. NYC 311 has rows where `closed_date <= created_date`
(timestamp skew between agencies). Naively writing
`tstzrange(created_date, closed_date, '[)')` produced an `empty` range, which
*passed* the check (`lower(empty) IS NULL`, so all CHECK branches are NULL, and
PostgreSQL treats NULL CHECK as OK) — but then `temporal && X` matched nothing
and the row was invisible to temporal search forever. Silent data loss.

Fixed in the blog (and in [sql/02_schema.sql](sql/02_schema.sql)) by adding
`not isempty(temporal)` to the constraint so degenerate ranges are now
rejected at write time. The loader in [src/load.ts](src/load.ts#L114-L121)
still has a defensive `[t,t]` fallback when `closed <= created`, which is
the right call — the constraint is the safety net, the loader is the
policy for what to do with messy data.

### 3. `postgres@3` template tag rejects `object[]` parameters — **resolved with `sql.typed`**

We probed empirically how `postgres@3.4.9` serializes a JS array bound to
`::jsonb[]`:

| Form | Typechecks? | Runtime |
|---|---|---|
| `${objs}::jsonb[]` (raw array of objects) | ❌ (object[] not in param union) | ✅ |
| `${objs as any}::jsonb[]` | ✅ via cast | ✅ |
| `${objs.map(JSON.stringify)}::jsonb[]` | ✅ | ❌ — stored as JSON string scalars (the warned-against form) |
| `${sql.array(objs, 3802)}` | ❌ (still needs cast inside) | ✅ |
| **`${sql.typed(objs, 3807)}`** | **✅ no cast** | ✅ |

The proper API is `sql.typed(value, oid)`. Its generic overload signature is
`<T>(value: T, oid: number) => Parameter<T>` — `T` is unconstrained, so any
JS value is accepted, and the OID parameter types it at the wire level.

For `jsonb[]`, OID 3807 (`pg_type._jsonb`) is the built-in PG type ID,
stable across versions. With it, no `::jsonb[]` SQL cast is needed *and*
no `as any` on the JS side. The driver still does the right serialization
(per-element JSON encoding, not the string-scalar trap).

Step 1's inset now spells this out:

```ts
const JSONB_ARRAY_OID = 3807;
${sql.typed(metas, JSONB_ARRAY_OID)}     // typed, no cast
```

Primitive arrays don't need this dance — `string[]` already matches the
template tag's parameter type, so `${trees}::ltree[]` and
`${temporals}::tstzrange[]` work directly (also verified — postgres@3
escapes range and ltree array elements correctly).

### 4. `OPENAI_API_KEY` plumbing was implied, never named — **fixed upstream**

`@ai-sdk/openai`'s `openai.embeddingModel(...)` reads `OPENAI_API_KEY` at
module-eval time, so a late `dotenv.config()` produces a confusing
"missing key" error from inside `embedMany`. Prerequisites now names both
env vars and warns about the eager read. [src/env.ts](src/env.ts) shows
the load-both-files pattern (project-local `.env` plus the repo root).

### 5. `prepare: false` for Ghost / Timescale Cloud

Not in the tutorial but worth mentioning: the connection-pooler in front of
Ghost / Timescale Cloud doesn't speak Postgres extended-protocol PREPARE
across pooler-managed sessions reliably. `postgres({ prepare: false })`
avoids "prepared statement does not exist" surprises when the pool rotates
connections under load. See [src/db.ts](src/db.ts). Should be in the post's
Prerequisites or in a "Connecting" note.

### 6. `bm25Search` uses `id desc` tiebreak but BM25 scores are not always
unique-per-id — already documented correctly

Worth flagging that the post *does* discuss this (the "BM25 scores tie
heavily on structured corpora" decision-rationale paragraph in Step 1).
Confirmed in the 311 data: lots of `Noise - Vehicle: Car/Truck Music` rows
share identical BM25 scores; the `id desc` secondary sort is doing real work.

### 7. Hybrid query produces small fused scores — easy to misread

Step 6c documents `k=60` and `RRF returns small fused values`, but the
actual numbers in my run (top fused score ≈ 0.016) look like garbage at a
glance. The MCP tool description's "hybrid (RRF) returns small fused
values; not comparable across queries" is the right message and made it
into Step 7 — but Step 6c itself doesn't say "expect numbers like
1/(60+1) + 1/(60+1) ≈ 0.033 max." Adding "expected magnitude is roughly
`2 / (k + 1)` ≈ 0.033 with `k=60`" to Step 6c would help.

### 8. `searchDocuments` filter-only with `near`: kNN ordering subtlety

The kNN branch in `filterOnly` orders by `geom <-> ST_SetSRID(...)`, but the
*selected* column is `1.0::float as score` — so the agent sees identical
scores while results are actually distance-ordered. The post's caveat in
6f ("the kNN operator does not compose with text or vector ranking") covers
this, but the implementation should probably emit `meters` as the
distinguishing field (and it does, via `metersProj`). Mention in passing
that "score is flat, `meters` is the real ranking signal" for the
filter-only-with-near path.

### 9. `embedding_version` defaults vs. trigger ordering — verified

I was worried about the case where an insert with `embedding=NULL` fires
the `documents_enqueue_on_insert` trigger *before* the `documents_before_update`
trigger could touch `embedding_version`. It doesn't — BEFORE INSERT is not
defined in the post, only BEFORE UPDATE. So the inserted row keeps its
`default 1` for `embedding_version` and the queue job is enqueued with
version=1. Correct. No issue, just spent some time verifying.

### 10. PostgreSQL 18 dependency made explicit — **fixed upstream**

`uuidv7()` and `uuid_extract_version()` are 18-only; on 17 the schema
flat-out won't apply. Prerequisites now spells out the dependency and
gives the `gen_random_uuid()` fallback for older majors. Ghost's default
new instance is PG18, so this Just Worked for the demo.

## What I verified end-to-end

| Step | Snippet                                  | Status |
|------|------------------------------------------|--------|
| 1    | `documents` table + check constraints     | OK     |
| 2    | All 6 indexes                             | OK     |
| 3    | `documents_before_update` trigger         | OK     |
| 4a   | `embedding_queue` table + indexes         | OK     |
| 4b   | Enqueue triggers (insert + update)        | OK     |
| 4c   | `claim_embedding_batch` PL/pgSQL          | OK     |
| 4d   | `prune_embedding_queue`                   | OK     |
| 5    | Worker w/ batch=128, bulk UNNEST writeback| OK, 43 rows/s |
| 6a   | BM25 search                               | OK     |
| 6b   | Vector search                             | OK     |
| 6c   | Hybrid RRF                                | OK     |
| 6d   | ltree subtree                             | OK     |
| 6e   | Temporal overlap                          | OK (after fixing demo's hardcoded window) |
| 6f   | Geo `ST_DWithin` + `meters`               | OK     |
| 6g   | JSONB containment                         | OK     |
| 6h   | `searchDocuments` composition             | OK     |
| 7    | MCP server boots, tool registers          | OK     |

No snippet was outright broken. The post is in good shape; the items
above are friction points, not bugs.
