# Tutorial issues found while building demo_311

Concrete problems / gotchas encountered while running the tutorial's code against a fresh ghost.build database with 10k NYC 311 service requests. Ordered by impact.

---

## 1. Wrong extension name — `pg_search` doesn't exist on ghost.build / Tiger Cloud

**Severity:** blocks the tutorial completely at step 0.

**Tutorial says** (Prerequisites):

```sql
create extension if not exists pg_search;     -- BM25
```

**Reality on ghost.build:** the extension is `pg_textsearch` (Tiger's BM25 extension), not `pg_search` (which is the ParadeDB extension). `create extension pg_search` fails:

```
ERROR: could not open extension control file
"/usr/share/postgresql/18/extension/pg_search.control": No such file or directory
```

`select * from pg_available_extensions where name ilike '%search%'` returns only `pg_textsearch 1.1.0`.

The two extensions are *not* the same product — `pg_search` is ParadeDB's, `pg_textsearch` is Tiger Data's — but they happen to expose **the same surface area** the tutorial uses: `using bm25 (...)` index, `<@>` operator, `to_bm25query(query, 'index_name')` function, `text_config`/`k1`/`b` storage parameters. So once the extension name is fixed, the rest of the BM25 code in the tutorial works unchanged.

**Fix:** change the Prerequisites snippet to `pg_textsearch`. Either:

- Drop the line "If you want a hosted service, use Tigerdata or ghost.build — they're the only managed Postgres providers that ship `pg_search`" (false — they ship `pg_textsearch`), or
- Say "they ship Tiger Data's `pg_textsearch`, which is wire-compatible with the BM25 syntax shown below." Plus update the `create extension` line.

---

## 2. The worker's per-row writeback is the throughput ceiling, and the tutorial doesn't say so

**Severity:** correctness-fine, throughput-poor. Easy to miss until you load real data.

The tutorial's Step 5 worker does **two round-trips per row** in the writeback loop:

```typescript
for (let i = 0; i < claimed.length; i++) {
  ...
  await sql`update documents set embedding = ... where id = ... and embedding_version = ...`;
  await sql`update embedding_queue set outcome = 'completed' where id = ...`;
}
```

With `BATCH_SIZE = 256` and a cloud DB ~50–80ms RTT, the writeback alone is ~25–40 seconds per batch. The OpenAI batch embed call itself is ~1–2s. So **>95% of wall-clock per batch is sequential per-row UPDATEs**.

Concrete measurement against demo_311 (ghost.build / 10k rows / batch 256):

- 256 embeddings from OpenAI: ~1s
- 256 + 256 = 512 round-trip UPDATEs: ~25s
- → throughput ceiling ~130 rows/min on a single worker

The tutorial says "Multiple workers, zero coordination. Thanks to `SKIP LOCKED`, you can run 1 or 10 workers without changing any code." That's true, but a single worker should not be capped at ~130/min — the loop itself is the bottleneck, not the queue or OpenAI.

**Suggested fix in the tutorial** — fold the writeback into a single SQL round-trip per batch using `unnest`:

```typescript
const ids       = claimed.map(r => r.document_id);
const versions  = claimed.map(r => r.embedding_version);
const queueIds  = claimed.map(r => r.queue_id);
const vecs      = embeddings.map(e => `[${e.join(',')}]`);

// 1 round trip: update all docs that still match their version, return success/failure
const written = await sql`
  with input as (
    select * from unnest(${ids}::uuid[], ${versions}::int[], ${queueIds}::bigint[], ${vecs}::text[])
                   as t(doc_id, ver, q_id, vec)
  ),
  upd as (
    update documents d
       set embedding = i.vec::halfvec
      from input i
     where d.id = i.doc_id and d.embedding_version = i.ver
    returning d.id, i.q_id
  )
  update embedding_queue eq
     set outcome = case when upd.id is null then 'cancelled' else 'completed' end
    from input i
    left join upd on upd.q_id = i.q_id
   where eq.id = i.q_id
  returning eq.id
`;
```

That brings per-batch wall-clock to ~OpenAI-call + 1 round-trip, ~10x throughput on a single worker.

Or, at minimum, say in prose: "the per-row writeback loop is fine for prototypes but becomes the throughput bottleneck on a cloud DB. Bulk it with `unnest` for production."

---

## 3. `meta @> ${object}::jsonb` works in `postgres-js` only because of auto-serialization — worth one line of explanation

**Severity:** trap door. The code works as written, but it works for a non-obvious reason.

The tutorial's filter:

```typescript
parts.push(sql`and meta @> ${p.meta}::jsonb`);
```

This passes a JavaScript object directly into a `::jsonb` placeholder. `postgres-js` recognizes this and serializes the object as JSON automatically. The instinct (especially for people coming from `pg` / node-postgres) is to `JSON.stringify` the object first — and that *silently produces wrong results*, not an error:

```typescript
// WRONG — silently returns 0 rows
sql`and meta @> ${JSON.stringify(p.meta)}::jsonb`
```

The reason: `postgres-js` text-serializes the already-JSON string, double-encoding it. The bind value becomes `"{\"agency\":\"NYPD\"}"` (a JSON string, not a JSON object), and `jsonb @> '"..."'` matches nothing.

I hit this immediately when translating the search code (was returning 0 results for mode 7 against a corpus that clearly had matching rows).

**Suggested fix in the tutorial:** one parenthetical after the `buildFilters` snippet:

> Note: pass the meta object directly — `postgres-js` auto-serializes it for `::jsonb`. Don't `JSON.stringify` it yourself or the result is double-encoded and matches nothing.

---

## 4. The MCP server example omits the `temporal` filter that Step 6e introduces

**Severity:** minor inconsistency. The MCP tool description in Step 7 lists "tree, meta, temporal, and near" as filter dimensions, but the `inputSchema` only defines `tree`, `meta`, and `near`. `temporal` is in the description text but never wired into the Zod schema or the handler.

The fix is one schema entry:

```typescript
temporal: z.object({
  from: z.string().optional().nullable(),
  to:   z.string().optional().nullable(),
}).optional().nullable().describe('ISO timestamps; documents whose temporal range overlaps [from,to)'),
```

…plus passing `args.temporal ?? undefined` into `searchDocuments`. (Done in this demo's [src/mcp-server.ts](src/mcp-server.ts).)

---

## 5. `searchDocuments` doesn't take a `temporal` parameter at all

**Severity:** related to #4 but upstream. `SearchParams` in Step 6h declares `tree`, `meta`, and `near`, but no `temporal`. So even if you wanted to filter by time across the modes (which Step 6e shows in SQL), the TypeScript surface area in the same step doesn't expose it.

The composition example in Step 6 ("Composing the modes") shows `temporal && tstzrange(...)` in a hand-written query, but the helper function never gets it. This demo adds it (see `temporalFilter` in [src/search.ts](src/search.ts:131)).

---

## 6. Step 6c says "Run BM25 and vector queries in parallel (one DB roundtrip each)" — `searchDocuments` does it, but the SQL above it doesn't show how

The SQL block under 6c shows the order-restore query:

```sql
select * from documents
where id = any($1::uuid[])
order by array_position($1::uuid[], id);
```

It is **not** obvious from that block that the two ranked candidate queries (BM25 + vector) are supposed to be run in parallel from the application, fused in TypeScript, and then re-fetched. The reader has to skip down to 6h to figure that out, by which point they may have written a single SQL query with both `<@>` and `<=>` clauses that doesn't fuse properly.

Minor structural fix: in 6c, briefly mention "the candidate queries are the BM25 query from 6a and the vector query from 6b, run in parallel; see 6h for the full implementation."

---

## 7. Tutorial's `claim_embedding_batch` works, but its return shape is `OUT`-parameter style — easy to mis-translate

**Severity:** translation hazard, not a bug.

The function uses PL/pgSQL's "assign-to-OUT-params-then-return-next" pattern:

```sql
queue_id          := rec.id;
document_id       := rec.document_id;
embedding_version := rec.embedding_version;
content           := doc.content;
return next;
```

This is correct, but it's an uncommon style today (most people write `RETURN QUERY` or `RETURNS TABLE` with a `SELECT … FROM` body). Translators may convert it to a `RETURN QUERY` form and lose the per-row guards (version recheck, document-existence check) that depend on the imperative loop.

Not really a *bug* — but for a tutorial aimed at being copy-pasted, a one-sentence comment near the function ("the per-row guards inside the loop are why this is imperative; do not refactor to a single SELECT") would help.

---

## Things the tutorial got right (where I expected to find issues but didn't)

- The `before update` trigger logic with `is distinct from` correctly handles the worker-writeback case (no double-fire on the version bump path).
- The `enqueue` trigger `when` clauses correctly skip both inserts with embeddings already present and re-bump-of-already-attempted-rows.
- The `for update skip locked` claim function works correctly under concurrent workers (verified by running two workers in parallel briefly).
- The temporal `check` constraint accepts `[t,t]` point-in-time and `[start,end)` ranges as documented.
- The PostGIS `(lon, lat)` order warning is appropriate — I bound `geom = ST_SetSRID(ST_MakePoint(lon, lat), 4326)` and got correct Times Square results; it would have been wrong with `(lat, lon)`.
- `pg_textsearch` honors `to_bm25query(text, 'index_name')` and the `<@>` operator exactly as the tutorial describes — the `< 0` selectivity-filter idiom in `where content <@> ... < 0` works.
- HNSW + `halfvec(1536)` works with `<=>` and the `halfvec_cosine_ops` operator class; `text-embedding-3-small` embeddings cast cleanly into `halfvec` and produce meaningful semantic ranking.
