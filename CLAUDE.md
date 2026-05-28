# cevian-content

Blog drafts plus a working demo (`demo_311/`) used to audit each post against a real corpus before publishing. The blog and the demo evolve together — when the demo surfaces a problem, both get patched in the same commit.

## postgres@3 array-serializer trap (load.ts)

The loader inserts batches via `unnest(typed[]...)` with one TS array per column. For the `meta` (jsonb) column, **only the pre-stringified `text[]::jsonb[]` form is safe**:

```ts
${metas.map(m => JSON.stringify(m))}::text[]::jsonb[]
```

Why the obvious alternatives are broken:

- `${metas}::jsonb[]` — doesn't typecheck. postgres@3's template tag accepts primitive arrays (`string[]`, `number[]`, …) but rejects `object[]` at the type level.
- `${metas as any}::jsonb[]` — typechecks, runs, **crashes at runtime on any element with a top-level `type` key**.
- `${sql.typed(metas, 3807)}` (jsonb[] OID) — same crash, same code path.

The mechanism, exact:

1. Both `as any` and `sql.typed` route through postgres.js's `arraySerializer` in `node_modules/postgres/src/types.js:241`.
2. Line 264 runs `serializer(x.type ? x.value : x)` on every element — a structural check intended to unwrap nested `Parameter` instances (which have shape `{value, type, array}`).
3. The check is `x.type ?` not `x instanceof Parameter`, so any plain object with a truthy `.type` field gets misread as a Parameter.
4. The serializer for jsonb is `JSON.stringify`. It receives `x.value` (= `undefined`), returns the JS value `undefined` (not the string `"undefined"`).
5. `arrayEscape` then calls `.replace` on `undefined` → `TypeError: Cannot read properties of undefined (reading 'replace')`.

Verified empirically against the live Ghost DB on 2026-05-28: A (`as any` + `type` key) and C (`sql.typed` + `type` key) both crash with the `replace` error; B and D (same forms, no `type` key) succeed; E (`map(JSON.stringify)` → `text[]::jsonb[]`) and F (`sql.json(batch)` + `jsonb_array_elements`) both round-trip objects correctly with the `type` key present.

This matters specifically because [blog_rag_tutorial.md:96](blog_rag_tutorial.md#L96) recommends `meta->>'type'` as the canonical discriminator pattern for mixed-corpus tables. A reader following that recommendation would crash on the first batch with any form other than E or F.

The post's old warning ("Don't `${metas.map(JSON.stringify)}::jsonb[]`: the driver already JSON-encodes each element, and pre-stringifying makes Postgres store them as JSON string scalars") was **wrong** for the `text[]::jsonb[]` path. With explicit `::text[]` typing in the SQL cast chain, postgres.js infers `text[]` (driver serializer is just `'' + x`, no JSON encoding), then PG's server-side `jsonb_in` parses each text element as an object. Verified by round-tripping `{type: 'email', subject: 'hi'}` through this path and getting an object back, not a string scalar.

## Loader column-cast convention

Every column in the loader's `unnest(...)` casts to its target PG type inline:

```ts
${contents}::text[],
${metas.map(m => JSON.stringify(m))}::text[]::jsonb[],
${trees}::ltree[],
${temporals}::tstzrange[],
${lons}::float8[],
${lats}::float8[]
```

Keep the cast in the `unnest` (not the `select`) so the unnest reads top-to-bottom as "here's how each column gets its type" — that's the inset's pedagogical point. The `meta` double-cast `::text[]::jsonb[]` looks unusual but is consistent with the rest: text on the wire, jsonb at the column. Moving `meta::jsonb` into the select would split type information across two locations for one column only, breaking the visual rhythm.

Memory: the `::jsonb[]` cast is eager on the FROM-clause parameter, so PG materializes a full `jsonb[]` intermediate (~100 KB transient at 200 rows, ~5 MB at 10k). Negligible at this snippet's "steady-state inserts" target; bulk backfills use `COPY` (Going further section) and bypass this path entirely.

## Published companion repo

`github.com/timescale/rag-postgres-tutorial` (private as of 2026-05-27) mirrors this repo's full history. The remote name is `timescale`; pushes go to `main`. Flip to public via `gh repo edit timescale/rag-postgres-tutorial --visibility public` when ready.
