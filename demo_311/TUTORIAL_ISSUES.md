# Tutorial issues found while building demo_311

A fresh implementation that transplants each code block from
`blog_rag_tutorial.md` into a working NYC 311 corpus (520 documents,
all seven search modes end-to-end). The tutorial's runtime behavior
is correct: SQL applies cleanly, the worker drains the queue, every
search mode returns sensible results, and the MCP server boots and
advertises the tool. The issues below are minor and all surface at
**TypeScript compile time** — `tsx` runs them without complaint, but
`tsc --noEmit` rejects them.

## 1. `${meta}::jsonb` is rejected by postgres-js types — **fixed**

**Was.** Step 6h's `buildFilters` used the bare object form:

```ts
parts.push(sql`and meta @> ${p.meta}::jsonb`);
```

which `tsc` rejected because `Record<string, unknown>` isn't assignable
to postgres-js's `ParameterOrFragment<never>` — even though it works at
runtime (the library auto-serializes plain objects, and the tutorial's
own comment confirmed this).

**Now.** Tutorial and demo both use `sql.json(...)`, the helper
postgres-js provides for exactly this case:

```ts
parts.push(sql`and meta @> ${sql.json(p.meta)}::jsonb`);
```

`sql.json` requires `JSONValue` instead of `unknown`, so `SearchParams.meta`
also widened from `Record<string, unknown>` to `Record<string, any>`.
The 521-row demo still returns the same `agency: 'NYPD'` matches; `tsc
--noEmit` is clean on both files; and the original "don't `JSON.stringify`
yourself" warning carries forward (confirmed empirically — stringified
meta returns 0 matches, `sql.json` and raw object both return 355).

## 2. MCP zod schema's `.nullable()` doesn't strip nulls inside nested objects — **fixed**

**Was.** Step 7's MCP handler unwrapped only the outer null:

```ts
temporal: args.temporal ?? undefined,   // outer null only
```

If the LLM sent `{"temporal":{"from":null,"to":"2026-01-01"}}`, the inner
`from: null` survived and violated `SearchParams.temporal.from: string|undefined`.

**Now.** The handler extends the same "unwrap `null → undefined`" pattern
into the nested object:

```ts
temporal: args.temporal ? {
  from: args.temporal.from ?? undefined,
  to:   args.temporal.to   ?? undefined,
} : undefined,
```

Verified by sending the MCP server `{"semantic":"noise","temporal":{"from":"2026-04-01","to":null}}`
over stdio JSON-RPC — the handler now routes to the one-sided
`upper(temporal) > from` branch and returns valid noise complaints. `tsc
--noEmit` is clean on every file.

Tutorial's `near` field is `z.number()` (non-nullable) at the leaves and
`meta` is `z.record(z.string(), z.any())` — neither has the same shape,
so `temporal` was the only field that needed this. If the corpus grows
another `.optional().nullable()`-leafed nested object in the future, the
same recursive-unwrap pattern applies.

## 3. `<@>` semantics ("lower is better" + `< 0`) could use a line — **fixed**

**Was.** Step 6a explained `<@>` only as "BM25 distance (lower is better)."
But the surrounding `where ... < 0` filter is what actually excludes
non-matching rows: `pg_textsearch` returns *negative* distances for
matches and `0` for non-matches. Without that detail, the `< 0` looks
like an arbitrary threshold and a reader copying the snippet may try
to drop or tweak it.

**Now.** Step 6a now states the encoding explicitly — *"matches come
back as negative values (more negative = better match), and rows that
don't match at all return 0. That's why the `where` clause filters on
`< 0`."* — and explains the `-(... )` in the `select` as the flip into
a positive similarity score.

## Things that worked exactly as documented

- All seven SQL files (extensions, schema, indexes, before-update
  trigger, queue table, enqueue triggers, claim function) applied
  in order without a single edit, against a fresh ghost.build
  Postgres-18.
- The worker's bulk `unnest`+CTE writeback drained 520 jobs in 11
  batches of 50, end-to-end ~30 s including embedding calls. No
  per-row roundtrips.
- The hybrid path's `fetchByIds` + `array_position` correctly
  preserves RRF order — confirmed visually (overlap items score
  ~0.032 = 2/(60+1), singletons score ~0.016 = 1/(60+1)).
- Composed queries (hybrid + tree + meta + near) ran in a single
  SQL pass and returned the expected Manhattan/NYPD/noise subset.
- The MCP server's `tools/list` returned the full schema and the
  generated JSON schema is well-formed.
