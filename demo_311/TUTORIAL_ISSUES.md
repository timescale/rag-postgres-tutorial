# Tutorial issues found while building demo_311 — resolved

Concrete problems / gotchas caught while running the tutorial's code against a fresh ghost.build database with 10k NYC 311 service requests. All seven have now been folded back into [blog_rag_tutorial.md](../blog_rag_tutorial.md); this file is the record of what was found and what was changed.

---

## 1. Wrong extension name — `pg_search` doesn't exist on ghost.build / Tiger Cloud — FIXED

**Was:** `create extension if not exists pg_search;` — failed with `could not open extension control file "/usr/share/postgresql/18/extension/pg_search.control"`.

**Now:** `create extension if not exists pg_textsearch;` plus updated prose explaining that ghost.build / Tigerdata ship Tiger Data's `pg_textsearch`, whose BM25 surface (`using bm25`, `<@>`, `to_bm25query`, `text_config`/`k1`/`b`) is what the tutorial actually uses.

---

## 2. Per-row writeback was the throughput ceiling — FIXED

**Was:** Step 5 worker did 2 `UPDATE`s per row in a loop. On a cloud DB at 50–80ms RTT with batch 256, ~25–40s/batch was just network wait. Single worker capped at ~130 rows/min.

**Now:** writeback collapsed to one round trip per batch via `unnest` + a CTE that returns the per-row outcome (`completed` if version matched, `cancelled` if not). Same semantics, ~10x throughput on a single worker.

---

## 3. `meta @> ${obj}::jsonb` works only because postgres-js auto-serializes — FIXED

**Was:** code worked, but for a non-obvious reason. Calling `JSON.stringify(p.meta)` before binding silently returned 0 rows (double-encoded JSON string).

**Now:** one-line comment in `buildFilters` warning not to call `JSON.stringify` and explaining that postgres-js handles it.

---

## 4. MCP server `inputSchema` was missing `temporal` — FIXED

**Was:** Step 7 description listed `temporal` as a filter but the Zod schema and the handler didn't include it.

**Now:** `temporal: z.object({ from, to }).optional().nullable()` is in the schema, and the handler passes it through to `searchDocuments`.

---

## 5. `SearchParams` had no `temporal` field — FIXED

**Was:** Step 6h's `SearchParams` exposed `tree`, `meta`, and `near`, but `temporal` from Step 6e was only ever a hand-written SQL clause. The helper couldn't filter by time at all.

**Now:** `SearchParams.temporal?: { from?: string; to?: string }` is part of the interface, and `buildFilters` emits the right `&&` / `upper > from` / `lower < to` predicate depending on which bounds are present.

---

## 6. Hybrid (6c) didn't say "two queries, in parallel, from the application" — FIXED

**Was:** the intro line "Run BM25 and vector queries in parallel" was true, but the rest of the section showed only the order-restore SQL and the RRF function. Readers could easily write a single SQL query with both `<@>` and `<=>` clauses that doesn't fuse properly.

**Now:** intro paragraph explicitly says to use `Promise.all` from the application and **not** to combine the two into one SQL query, with a forward reference to `searchDocuments` for the full glue. An extra parenthetical explains the `array_position` ordering trap.

---

## 7. `claim_embedding_batch` imperative PL/pgSQL style was an invitation to break it — FIXED

**Was:** function used `FOR ... LOOP` + `RETURN NEXT` with per-row guards inside the loop. The shape invited refactoring to `RETURN QUERY SELECT ...`, which collapses the version-recheck/document-existence guards into the planner's order of operations and breaks the version-race correctness.

**Now:** a paragraph after the function explains that the imperative shape is deliberate and lists what breaks if you refactor it.

---

## Things the tutorial got right (where I expected to find issues but didn't)

- The `before update` trigger logic with `is distinct from` correctly handles the worker-writeback case (no double-fire on the version bump path).
- The `enqueue` trigger `when` clauses correctly skip both inserts with embeddings already present and re-bump-of-already-attempted-rows.
- The `for update skip locked` claim function works correctly under concurrent workers.
- The temporal `check` constraint accepts `[t,t]` point-in-time and `[start,end)` ranges as documented.
- The PostGIS `(lon, lat)` order warning is appropriate — binding `geom = ST_SetSRID(ST_MakePoint(lon, lat), 4326)` with Times Square's (-73.9855, 40.7580) returns the right block; `(lat, lon)` would have landed in the Atlantic.
- `pg_textsearch` honors `to_bm25query(text, 'index_name')` and the `<@>` operator exactly as the tutorial describes — the `<@> ... < 0` selectivity-filter idiom in the `WHERE` works.
- HNSW + `halfvec(1536)` works with `<=>` and the `halfvec_cosine_ops` operator class; `text-embedding-3-small` embeddings cast cleanly into `halfvec` and produce meaningful semantic ranking.
- `postgres-js` does flatten an array of `sql` fragments interpolated into a single placeholder (`sql\`where true ${parts}\``), so the tutorial's `buildFilters` pattern works as written — verified with mode 8 (composition).
