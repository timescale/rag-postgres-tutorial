# demo_311 — running notes & tutorial findings

NYC 311 walkthrough of `blog_rag_tutorial.md`. 500 service requests from the
Socrata API (`erm2-nwe9`), one row per request.

## What works

End-to-end happy path — schema, indexes, trigger, queue, claim function, worker,
search modes, MCP server — runs as written with only the small fixes below.

- 500 rows ingested in **4.2 s** (single transaction batches of 200).
- 500 embeddings drained from the queue in **34.83 s, ~14.4 rows/s avg** with
  `BATCH_SIZE=64`, single worker, against a cloud DB. Per-batch profile:
  ~500 ms in `embedMany` (one HTTP call to OpenAI for 64 texts), ~2.0–3.5 s in
  the version-guarded writeback — the write is the bottleneck, dominated by
  network RTT to the cloud DB, not the embedding call. A second worker would
  near-double throughput.
- All seven modes return results: BM25, vector, hybrid (RRF), ltree subtree,
  JSONB containment, temporal overlap, geo radius/kNN. Composition of four
  modes (`fulltext + tree + meta + near`) in a single query also works.

## Tutorial issues found while testing

### Real bugs (would break a fresh implementation)

1. **None broke the runtime.** The literal SQL/TypeScript in the tutorial is
   copy-pasteable and runs as written.

### Type-strictness friction (compiles after small casts, no runtime issue)

2. **Step 6h `buildFilters` array splat.** The tutorial writes
   `return parts.length > 0 ? sql\`${parts}\` : sql\`\`\`;` — at runtime
   `postgres-js` accepts an array of `sql` fragments and joins them with spaces
   (verified by running the exact tutorial form against this DB). But under
   `tsc --strict`, `parts: any[]` (the tutorial's type) silently lets it pass,
   while a typed `parts: PendingFragment[]` does not — `Helper` does not
   accept an array. The post should either annotate `parts: any[]` (the
   tutorial's `const parts = []` in JS infers `never[]`, which is wrong for
   the TS version) or cast at the splat: `sql\`${parts as any}\``.

3. **Step 6h `sql.json(p.meta)`** — `sql.json(obj as any)` is required under
   strict TS because `postgres-js`'s `JSONValue` excludes `Record<string, any>`
   without coercion. The tutorial's plain `sql.json(p.meta)` works in JS but
   not strict-TS.

### Minor inconsistencies (harmless but worth fixing)

4. **Step 4c claim function — `doc.content is null` check is unreachable.**
   The schema declares `content text not null`, so the `if not found or
   doc.content is null then ... 'cancelled'` branch only reaches the
   `not found` half. Either drop the `or doc.content is null` clause or
   change the schema decision in the same step.

5. **Steps 4b enqueue trigger & Step 2 partial index — literal `3` instead of
   `max_attempts`.** Both reference `embedding_attempts < 3`. The queue table
   defines `max_attempts int default 3`. If a user bumps the default they have
   to remember to update two more places — would be cleaner to use the column.

6. **Step 7 MCP description says "max 1000"** but the handler does
   `args.limit && args.limit > 0 ? args.limit : 10` — no upper bound enforced.
   A misbehaving agent that passes `limit: 1000000` will issue that query.
   Easy fix: `Math.min(args.limit, 1000)` (used in `src/mcp-server.ts`).

7. **Step 5 worker comment vs. code mismatch.** The inline comment in the
   batch-writeback says "at 50–80ms RTT and batch 256", but the example call
   uses `claim_embedding_batch(10, '5 minutes')`. The default in the SQL
   function is also `10`. Either bump the SQL default to something realistic
   (32–64) or change the comment. With batch 10 against a cloud DB the worker
   is RTT-bound — I measured ~14 rows/s with batch 64; batch 10 would be
   materially worse.

### Suggestions that would strengthen the tutorial

8. **Tell readers to expect ~2–3 s per write batch when running against
   a cloud DB.** The post sells the asynchronous-embedding pattern partly on
   throughput, but the realistic bottleneck for a low-latency embedding model
   like `text-embedding-3-small` against a *remote* DB is the writeback, not
   the API call. Two co-located workers + one connection pool fix that, but
   it isn't called out.

9. **`buildContent` is upstream of everything else.** The tutorial covers
   chunking briefly in "Going further" but the *shape* of the denormalized
   blob (which fields, in what order, with what labels) is the single biggest
   knob for BM25 quality. Worth a paragraph in Step 1 with a 311-style
   example: `Complaint: ... / Descriptor: ... / Address: ... / Resolution: ...`.

10. **`buildTree` ltree label sanitization.** ltree labels are `[A-Za-z0-9_]`
    only, max 256 chars. Real corpora have `/`, `&`, spaces, hyphens
    (e.g. "Noise - Residential" → `noise___residential` without sanitization
    would error). One sentence in Step 1 or a `sanitizeLtreeLabel` helper in
    Step 6d would save the next reader from hitting `syntax error in ltree`
    at insert time.

## Layout

- `sql/` — the six SQL files in order (`01_extensions.sql` …
  `06_claim_function.sql`). Each one matches a step in the tutorial.
- `src/download.ts` — pull N rows from the Socrata API to `data/nyc311.jsonl`.
- `src/ingest.ts` — load JSONL into `documents` (single SQL `insert ... from
  jsonb_to_recordset(...)` per batch).
- `src/worker.ts` — drain `embedding_queue`. `DRAIN_THEN_EXIT=1` exits after
  one empty poll (used for timing). `BATCH_SIZE` env var sets the claim size.
- `src/search.ts` — the `searchDocuments` function from Step 6h.
- `src/search-cli.ts` — `npx tsx src/search-cli.ts '<json>'` exerciser.
- `src/mcp-server.ts` — Step 7, with a corpus-specific tool description.

## Repro

```sh
# from demo_311/
npm install
LIMIT=500 npx tsx src/download.ts
npx tsx src/ingest.ts
DRAIN_THEN_EXIT=1 BATCH_SIZE=64 npx tsx src/worker.ts   # ~35s
npx tsx src/search-cli.ts '{"fulltext":"pothole","limit":5}'
```
