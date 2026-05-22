# Building a Postgres Table for State-of-the-Art RAG

Most RAG (retrieval-augmented generation) stacks today rope together three or four systems: a SQL database for documents, a separate vector store for embeddings, a search engine for keyword queries, and some queue for backfilling. You end up writing custom sync code between all of them, paying for redundant infrastructure, and explaining transactional inconsistencies to your team.

And after all that work, what do you actually get? Three retrieval modes: BM25 keyword, vector semantic, and hybrid (RRF) over the two — plus metadata filtering if you're lucky and your vector store supports it. That's it. The moment you want to filter by "everything under `work.projects.acme`," or "documents authored last quarter," you're back to writing application code that pulls candidates from the vector store and re-filters them in memory — losing recall and paying for it twice.

You don't need any of that. Modern Postgres has everything required for a top-shelf RAG retrieval layer: BM25 full-text search, vector similarity via HNSW, hierarchical paths, geospatial indexes, JSONB filters, and a real job queue. This post walks through how to design a single table that supports **seven composable types of search**, plus asynchronous embedding generation, and exposes itself to AI agents through MCP:

1. **Text search (BM25)** — keyword and phrase matching, the classic search-engine signal.
2. **Semantic search (vector)** — cosine similarity over embeddings via HNSW, for paraphrase and concept matching.
3. **Hybrid search (RRF)** — Reciprocal Rank Fusion over BM25 and vector results, so the two cover for each other's failure modes.
4. **Hierarchical search (ltree)** — path queries like `work.projects.acme.*`, with index support and no recursive CTEs.
5. **Temporal search (tstzrange)** — point-in-time and range overlap queries against an indexed time column.
6. **Geospatial search (PostGIS)** — radius, polygon-containment, and nearest-neighbor queries on lat/lon points.
7. **Metadata search (JSONB)** — containment and attribute filters over arbitrary structured fields.

Every mode composes with every other in a single SQL query, with index support all the way down. No application-side post-filtering, no recall loss.

Everything below is portable — you can drop it into your own database today.

## What we're building

A `documents` table with:

- **Hybrid retrieval** — BM25 keyword search + vector similarity, fused with Reciprocal Rank Fusion (RRF)
- **Filters** — JSONB metadata, hierarchical `ltree` paths, time-range queries, PostGIS geometry, regex grep
- **Background embedding** — a transactional outbox queue + a worker that calls OpenAI/Ollama/whatever
- **MCP server** — agent-facing tools that wrap the SQL

We'll write straight SQL plus a few hundred lines of TypeScript. No ORMs, no external vector DB.

> **A note on scope.** What follows is the *maximal* schema — every column, index, and trigger needed to support all seven search types. Real corpora rarely need all of them. If your documents have no hierarchy, drop the `tree` column and its GiST index. If nothing is time-bounded, drop `temporal`. If nothing has a location, drop `geom` and the `postgis` extension. If you only ever do semantic search, drop the BM25 index. The pieces are independent; treat this post as a menu, not a prescription.
>
> We also assume **`content` is already chunked**. One row holds the unit of text you want to retrieve — a paragraph, a section, a comment, a 311 complaint description, whatever your chunking strategy produces. Chunking itself (sliding window, markdown-aware, semantic) is upstream of this schema; see "Going further" for the pattern of linking chunks back to a parent via `meta`.

## Prerequisites

PostgreSQL 18 with these extensions:

```sql
create extension if not exists vector;        -- pgvector: halfvec, HNSW
create extension if not exists ltree;         -- hierarchical paths
create extension if not exists postgis;       -- geospatial types and indexes
create extension if not exists pg_search;     -- BM25
```

> `halfvec` is 16-bit floats (2 bytes/dim) instead of `vector`'s 32-bit floats. Half the storage, indistinguishable recall for embedding models like `text-embedding-3-small`. Always prefer it.

If you want a hosted service, use [Tigerdata](https://tigerdata.com) or [ghost.build](https://ghost.build) — they're the only managed Postgres providers that ship `pg_search`. Other hosts will leave you stuck on `tsvector`/`tsquery`, which works but is materially worse than BM25 for ranking quality. If you're experimenting or doing AI-assisted development, prefer ghost.build: it has a generous free tier and its MCP server is purpose-built for agentic workflows, so Claude/Cursor can provision databases, run queries, and inspect schemas without you leaving the editor.

## Step 1 — The schema

```sql
create table documents
( id                  uuid          not null primary key default uuidv7()
                                    check (uuid_extract_version(id) = 7)
, content             text          not null                              -- the chunk text
, meta                jsonb         not null default '{}'                 -- arbitrary attrs
, tree                ltree         not null default ''::ltree            -- hierarchical path
, temporal            tstzrange                                           -- optional time range
, geom                geometry(Point, 4326)                               -- optional WGS84 point
, embedding           halfvec(1536)                                       -- nullable until embedded
, embedding_version   int           not null default 1                    -- bumps on content change
, embedding_attempts  int           not null default 0
, embedding_last_error text
, created_at          timestamptz   not null default now()
, updated_at          timestamptz
);

-- meta must be an object, not a scalar or array
alter table documents add check (jsonb_typeof(meta) = 'object');

-- temporal convention: point-in-time is [t,t] inclusive, ranges are [start,end)
alter table documents add constraint temporal_bounds_convention check (
    temporal is null
    or (lower(temporal) = upper(temporal) and lower_inc(temporal) and upper_inc(temporal))
    or (lower(temporal) <  upper(temporal) and lower_inc(temporal) and not upper_inc(temporal))
);
```

A few decisions worth explaining:

- **One table or many?** Depends on whether you want to search across document types together or keep them separate. If a single query should be able to retrieve a blog post, an email, and a PDF in the same ranked result list, put them in one table and express the type in `meta->>'type'` — you get one set of indexes and one BM25/HNSW build to maintain. If the corpora are genuinely independent (different access patterns, different lifecycles, different embedding models), separate tables are fine and the same schema below still applies per-table.
- **`embedding` is nullable.** Writes don't block on calling OpenAI. The vector is filled in asynchronously by a worker (Step 4). This is the single most important design decision in the whole post.
- **`embedding_version` enforces correctness.** When content changes, this number ticks. The worker only writes back if the version still matches what it claimed — otherwise it would clobber a fresh row with a stale vector.
- **`tree` (ltree) instead of `parent_id`.** Path queries (`work.projects.acme.notes <@ work.projects`) are O(log n) and don't need recursive CTEs. Patterns (`*.api.*`) and label queries (`api & v2`) are first-class.
- **`temporal` (tstzrange) is optional.** Point-in-time events (`[t,t]`) and date ranges (`[start,end)`) live in the same column with the same operators.
- **`geom` is a `geometry(Point, 4326)`.** SRID 4326 is WGS84 lat/lon — what GPS, OpenStreetMap, and basically every web map use. Store coordinates as `ST_SetSRID(ST_MakePoint(lon, lat), 4326)`. Note the order: PostGIS is `(longitude, latitude)`, not `(latitude, longitude)` — getting this wrong is the #1 PostGIS bug.

## Step 2 — The indexes

Six indexes, each justified:

```sql
-- JSONB attribute lookups: meta @> '{"type":"email"}'
create index documents_meta_gin_idx
  on documents using gin (meta);

-- Hierarchical path queries: tree <@ 'work.projects'
create index documents_tree_gist_idx
  on documents using gist (tree);

-- Range overlap & containment: temporal @> now() or temporal && range
create index documents_temporal_gist_idx
  on documents using gist (temporal)
  where temporal is not null;

-- Geospatial: ST_DWithin, ST_Intersects, <-> (kNN)
create index documents_geom_gist_idx
  on documents using gist (geom)
  where geom is not null;

-- BM25 full-text: content <@> to_bm25query(...)
create index documents_content_bm25_idx
  on documents using bm25 (content)
  with (text_config = 'english', k1 = 1.2, b = 0.75);

-- Vector similarity: embedding <=> query::halfvec
create index documents_embedding_hnsw_idx
  on documents using hnsw (embedding halfvec_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Partial index for the worker to find rows that still need embeddings
create index documents_pending_embedding_idx
  on documents (created_at)
  where embedding is null and embedding_attempts < 3;
```

Notes:

- `k1=1.2, b=0.75` are the BM25 defaults. Increase `k1` to reward repeated terms, decrease `b` to weaken document-length normalization.
- HNSW `m=16, ef_construction=64` is the safe default for ~1M docs. Bump `ef_construction` to 200+ if recall matters more than build time.
- The partial index is critical. Your `documents` table will grow forever, but rows-needing-embedding is small (transient). Querying `where embedding is null` on a million-row table without this would be a sequential scan.

## Step 3 — The before-update trigger

When `content` changes, the embedding becomes stale. Don't make application code remember this — push it down:

```sql
create function documents_before_update() returns trigger as $$
begin
  new.updated_at := now();

  -- Content changed: invalidate embedding and bump version
  if old.content is distinct from new.content
     and old.embedding is not distinct from new.embedding
  then
    new.embedding := null;
    new.embedding_version := old.embedding_version + 1;
    new.embedding_attempts := 0;
    new.embedding_last_error := null;
  end if;

  -- Worker writing the embedding back: clear error state
  if new.embedding is not null and old.embedding is distinct from new.embedding then
    new.embedding_attempts := 0;
    new.embedding_last_error := null;
  end if;

  return new;
end
$$ language plpgsql;

create trigger documents_before_update_trg
  before update on documents
  for each row execute function documents_before_update();
```

The `is distinct from` checks are deliberate — they treat NULLs as comparable, so a content change paired with the worker's embedding write doesn't trip both branches. The version bump is the contract between writers and the worker.

## Step 4 — The embedding queue

This is where most "we'll just call OpenAI in our INSERT path" implementations fall apart. Synchronous embedding calls turn a 5ms write into a 500ms one, fail under rate limits, and leave you no way to re-embed historical rows when you change models.

The fix is a transactional outbox: writes to `documents` enqueue a job in the same transaction, and a separate worker drains the queue.

### 4a. The queue table

```sql
create table embedding_queue
( id                bigint        generated always as identity primary key
, document_id       uuid          not null references documents(id) on delete cascade
, embedding_version int           not null              -- what version this job is for
, vt                timestamptz   not null default now() -- visibility timestamp
, outcome           text          check (outcome is null or outcome in
                                         ('completed','failed','cancelled'))
, attempts          int           not null default 0
, max_attempts      int           not null default 3
, last_error        text
, created_at        timestamptz   not null default now()
);

-- Workers claim by lowest vt where outcome is null
create index embedding_queue_claim_idx
  on embedding_queue (vt)
  where outcome is null;

-- Find the most recent job for a document (used to supersede older jobs)
create index embedding_queue_document_idx
  on embedding_queue (document_id, embedding_version desc)
  where outcome is null;

-- Pruning archive: finalized rows older than retention
create index embedding_queue_archive_idx
  on embedding_queue (created_at)
  where outcome is not null;
```

The columns to internalize:

- **`vt` (visibility timestamp)** — the row is invisible to workers until `vt <= now()`. New rows are visible immediately. When a worker claims, it pushes `vt` forward by the lock duration; if the worker crashes, the row becomes claimable again. This is what makes safe parallel embedding workers possible — many workers can pull from the same queue without stepping on each other or losing jobs to crashes. Same pattern AWS SQS uses.
- **`outcome` NULL = the job is open.** `'completed'`, `'failed'`, or `'cancelled'` are terminal states.
- **`attempts < max_attempts`** is the retry budget. Most production systems run with `max_attempts = 3`.

### 4b. The enqueue trigger

```sql
create function enqueue_embedding() returns trigger as $$
begin
  insert into embedding_queue (document_id, embedding_version)
  values (new.id, new.embedding_version);
  return new;
end
$$ language plpgsql;

create trigger documents_enqueue_on_insert
  after insert on documents
  for each row
  when (new.embedding is null)
  execute function enqueue_embedding();

create trigger documents_enqueue_on_update
  after update on documents
  for each row
  when (old.content is distinct from new.content
        and new.embedding is null
        and new.embedding_attempts < 3)
  execute function enqueue_embedding();
```

Two triggers, two `when` clauses. The insert one only fires when the application didn't provide an embedding upfront. The update one only fires when content actually changed and we haven't already exhausted attempts.

### 4c. The claim function

This is the heart of the queue — a single SQL function that atomically claims a batch and returns the work to do:

```sql
create function claim_embedding_batch(
  batch_size    int      default 10,
  lock_duration interval default '5 minutes'
)
returns table (queue_id bigint, document_id uuid, embedding_version int, content text)
language plpgsql as $$
declare
  rec record;
  doc record;
  claimed int := 0;
begin
  -- 1. Bulk-cancel jobs superseded by a newer version for the same document
  update embedding_queue eq
    set outcome = 'cancelled'
    where eq.outcome is null
      and eq.vt <= now()
      and exists (
        select 1 from embedding_queue newer
        where newer.document_id = eq.document_id
          and newer.embedding_version > eq.embedding_version
          and newer.outcome is null
      );

  -- 2. Reap jobs orphaned by crashed workers (attempts exhausted, never finalized)
  update embedding_queue
    set outcome = 'failed',
        last_error = coalesce(last_error, 'exceeded max attempts (worker crash)')
    where outcome is null and vt <= now() and attempts >= max_attempts;

  -- 3. Claim eligible rows, FOR UPDATE SKIP LOCKED so workers don't block each other
  for rec in
    select eq.id, eq.document_id, eq.embedding_version
    from embedding_queue eq
    where eq.outcome is null
      and eq.vt <= now()
      and eq.attempts < eq.max_attempts
    order by eq.vt
    for update skip locked
  loop
    -- Verify the document still exists and the version matches
    select d.content, d.embedding_version into doc
    from documents d where d.id = rec.document_id;

    if not found or doc.content is null then
      update embedding_queue set outcome = 'cancelled' where id = rec.id;
      continue;
    end if;

    if rec.embedding_version <> doc.embedding_version then
      update embedding_queue set outcome = 'cancelled' where id = rec.id;
      continue;
    end if;

    -- Claim: push vt into the future, increment attempts
    update embedding_queue
      set vt = now() + lock_duration,
          attempts = embedding_queue.attempts + 1
      where id = rec.id;

    queue_id          := rec.id;
    document_id       := rec.document_id;
    embedding_version := rec.embedding_version;
    content           := doc.content;
    return next;

    claimed := claimed + 1;
    exit when claimed >= batch_size;
  end loop;
end
$$;
```

Why each piece matters:

- **`for update skip locked`** is the secret sauce. Multiple workers can run `claim_embedding_batch` concurrently and they will never wait on each other — they'll just skip over rows already being claimed.
- **The supersession step** prevents wasted work. If you edit a document three times in a second, the queue ends up with three jobs; only the latest is worth processing.
- **The reap step** finalizes jobs whose worker crashed mid-write. Without this, the row gets reclaimed forever.
- **The version recheck inside the loop** catches the race where content changed between enqueue and claim. The worker would otherwise produce an embedding for stale text.

## Step 5 — The worker

The worker is a process (or several) that loops, claims batches, generates embeddings, writes them back. The shape:

```typescript
// worker.ts — pseudocode-ish, ~100 lines for the real thing
import { setTimeout as sleep } from 'node:timers/promises';
import { embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);
const model = openai.textEmbeddingModel('text-embedding-3-small');

async function processBatch() {
  // 1. Claim
  const claimed = await sql`
    select * from claim_embedding_batch(10, '5 minutes'::interval)
  `;
  if (claimed.length === 0) return 0;

  // 2. Embed (one HTTP call for the whole batch). The SDK retries 429s for us.
  const { embeddings } = await embedMany({
    model,
    values: claimed.map(r => r.content),
    maxRetries: 5,
  });

  // 3. Write back, version-guarded
  for (let i = 0; i < claimed.length; i++) {
    const row = claimed[i];
    const vec = `[${embeddings[i].join(',')}]`;

    const updated = await sql`
      update documents
      set embedding = ${vec}::halfvec
      where id = ${row.document_id}
        and embedding_version = ${row.embedding_version}
      returning id
    `;

    if (updated.length === 0) {
      // Content changed between claim and write — cancel the job
      await sql`update embedding_queue set outcome = 'cancelled' where id = ${row.queue_id}`;
    } else {
      await sql`update embedding_queue set outcome = 'completed' where id = ${row.queue_id}`;
    }
  }

  return claimed.length;
}

// Main loop with adaptive polling
async function run() {
  while (true) {
    const n = await processBatch();
    if (n === 0) await sleep(10_000);  // idle: 10s
    // else loop immediately — there might be more work
  }
}
```

The three behaviors to get right:

1. **Adaptive polling.** Loop immediately when you found work; sleep when idle. A worker that polls every 100ms when empty wastes the database.
2. **Version-guarded writeback** (`where embedding_version = $3`). This is the safety net for the race against concurrent content edits.
3. **Multiple workers, zero coordination.** Thanks to `SKIP LOCKED`, you can run 1 or 10 workers without changing any code. They'll partition the queue cleanly.

> **What about rate limits?** The AI SDK retries 429s with exponential backoff that respects `Retry-After`. For most workers, `maxRetries: 5` is plenty. If a request still fails after that, the batch raises, the visibility timeout on the queue rows lapses, and another worker (or the same one, after restart) picks them up — `attempts < max_attempts` in `claim_embedding_batch` is the final backstop. You only need custom rate-limit detection if you're running a multi-tenant worker that needs to pause globally on rate limits, or if you want to avoid counting 429s against a queue's retry budget. Both are advanced optimizations, not defaults.

You can run the worker as a systemd unit, a Kubernetes deployment, or a Fly.io machine. It's a single process; scale horizontally as throughput requires.

## Step 6 — The six search modes

Now the payoff. Each mode is a SQL pattern; they compose freely in the `where` clause of a single query.

### 6a. Text search (BM25)

```sql
select id, content,
       -(content <@> to_bm25query($1, 'documents_content_bm25_idx')) as score
from documents
where content <@> to_bm25query($1, 'documents_content_bm25_idx') < 0
order by score desc, created_at desc
limit 30;
```

`<@>` returns BM25 distance (lower is better). Negating it gives a similarity score, which sorts nicely. Use BM25 when the query contains names, code identifiers, exact phrases, or rare terminology where lexical match matters.

### 6b. Semantic search (vector)

First, embed the query text (call the same API your worker uses, with the query string). Then:

```sql
select id, content,
       (1 - (embedding <=> $1::halfvec)) as score
from documents
where embedding is not null
  and (embedding <=> $1::halfvec) < 1.0
order by score desc, created_at desc
limit 30;
```

`<=>` is cosine distance. `1 - distance` converts to similarity (0 to 1). Use this when the query is natural language and you want paraphrase / concept matching.

Add a threshold for noisy corpora:

```sql
... and (1 - (embedding <=> $1::halfvec)) >= 0.4
```

### 6c. Hybrid search (RRF)

Run BM25 and vector queries in parallel (one DB roundtrip each), then fuse with Reciprocal Rank Fusion:

```typescript
function rrfFusion(
  bm25: { id: string }[],
  semantic: { id: string }[],
  k = 60,
  weights = { fulltext: 1.0, semantic: 1.0 },
) {
  const scores = new Map<string, number>();

  bm25.forEach((r, i) => {
    const rank = i + 1;
    scores.set(r.id, (scores.get(r.id) ?? 0) + weights.fulltext / (k + rank));
  });

  semantic.forEach((r, i) => {
    const rank = i + 1;
    scores.set(r.id, (scores.get(r.id) ?? 0) + weights.semantic / (k + rank));
  });

  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
```

Then fetch the top N rows by ID, preserving order with `array_position`:

```sql
select * from documents
where id = any($1::uuid[])
order by array_position($1::uuid[], id);
```

Why RRF? It works without normalizing BM25 and cosine scores (which live on incompatible scales). It uses rank, not score magnitude. `k=60` is the value from the original Cormack et al. paper and is robust across query types.

Why not just normalize and weighted-sum? Because BM25 scores have unbounded distribution (long tail) and cosine similarity is bounded `[0,1]`. Min-max normalization is brittle when one list is empty or has one outlier. RRF is empirically more stable.

You can tune the weights when one signal is more reliable than the other for your domain. Start with `{fulltext: 1.0, semantic: 1.0}`.

**Prefer hybrid by default for free-text queries.** Vectors handle paraphrase and concept matching; BM25 handles names, code identifiers, exact phrases, and tail terminology. Either one alone has obvious failure modes; together they cover for each other.

### 6d. Hierarchical search (ltree)

Restrict results to a subtree of the document hierarchy:

```sql
select id, content, tree
from documents
where tree <@ 'work.projects.acme'::ltree   -- everything under work.projects.acme
order by created_at desc
limit 30;
```

Operators worth knowing:

- `<@` / `@>` — descendant / ancestor containment.
- `~` — `lquery` pattern matching, e.g. `tree ~ 'work.*.notes'::lquery`.
- `?` — match any of several patterns, e.g. `tree ? array['work.*', 'personal.*']::lquery[]`.

The GiST index from Step 2 handles all of them. Combine with any other mode — `tree <@ 'work.projects'` in the `where` of a BM25 or vector query restricts the search to that subtree before ranking.

### 6e. Temporal search (tstzrange)

Find rows whose temporal extent overlaps or contains a moment or window:

```sql
-- Documents whose validity range contains a specific instant
select id, content
from documents
where temporal @> $1::timestamptz;

-- Documents whose range overlaps a query window
select id, content
from documents
where temporal && tstzrange($1, $2, '[)');
```

`@>` is "contains," `&&` is "overlaps." Both use the GiST index on `temporal`. This composes with the other modes: a hybrid search restricted to "documents valid as of yesterday" is just `... and temporal @> '2026-05-21'::timestamptz` added to the BM25 and vector queries.

### 6f. Geospatial search (PostGIS)

Three flavors, all backed by the GiST index on `geom`:

```sql
-- 1. Radius: documents within 5km of a point (cast to geography for meters)
select id, content
from documents
where ST_DWithin(
        geom::geography,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,  -- ($1=lon, $2=lat)
        5000                                                 -- meters
      );

-- 2. Polygon containment: documents inside an arbitrary shape
select id, content
from documents
where ST_Intersects(geom, ST_GeomFromGeoJSON($1));

-- 3. Nearest-neighbor: the 10 closest documents to a point
select id, content,
       ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) as meters
from documents
where geom is not null
order by geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
limit 10;
```

A few traps worth knowing:

- **`geometry` vs `geography`.** `geometry` uses planar math (fast, but distances near the poles are wrong); `geography` uses spheroidal math (slower, but distances are real meters). Store as `geometry` (smaller, faster indexes) and cast to `::geography` whenever you need real-world distances. `ST_DWithin(geog, geog, meters)` is the canonical radius query.
- **`<->` is the kNN operator.** It uses the GiST index to walk nodes in distance order. This is the only PostGIS operator that gives you index-backed ordering — every other distance query is a scan with a sort. Use `<->` whenever you want "nearest N."
- **Coordinate order is `(lon, lat)`.** Worth repeating.

Two caveats on composition:

- **The geo *filter* composes with everything.** `ST_DWithin(...)` or `ST_Intersects(...)` slots into the `where` clause of any BM25 or vector query — it just restricts the candidate set before ranking. The planner picks whether to start from the geo index or the text/vector index based on selectivity.
- **The kNN *operator* (`<->`) does not compose with text or vector ranking.** It's an `ORDER BY` operator, and a query has only one primary sort. So you can rank by BM25 *or* cosine *or* distance, not all three. The `searchDocuments` function in 6h handles this by using `<->` only when geo is the *sole* signal; when text or vector is also present, it falls back to `ST_DWithin` as a filter and lets the text/vector score drive ordering.

### 6g. Metadata search (JSONB)

Containment filters on arbitrary structured attributes:

```sql
select id, content
from documents
where meta @> '{"type": "email", "status": "sent"}'::jsonb
order by created_at desc
limit 30;
```

`@>` is the JSONB containment operator and uses the GIN index from Step 2. You can also reach into nested paths:

```sql
where meta @> '{"author": {"team": "platform"}}'::jsonb
```

For range or inequality predicates on a JSONB field, cast and filter:

```sql
where (meta->>'priority')::int >= 3
```

(The GIN index doesn't help with that — add a B-tree expression index if it's a hot path.)

### Composing the modes

The whole point of doing this in one table is that every mode is just another `where` clause. A hybrid search over a subtree, restricted to a time window and a metadata facet, is one query per ranking signal:

```sql
select id, content,
       -(content <@> to_bm25query($1, 'documents_content_bm25_idx')) as score
from documents
where content <@> to_bm25query($1, 'documents_content_bm25_idx') < 0
  and tree <@ 'work.projects.acme'::ltree
  and temporal && tstzrange($2, $3, '[)')
  and ST_DWithin(geom::geography,
                 ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography,
                 $6)
  and meta @> '{"status": "published"}'::jsonb
order by score desc
limit 30;
```

Every clause has an index available; the planner decides which to use and where to apply remaining predicates as filters. Either way, the filtering happens in the database, not in your application — no recall loss from pre-filtering a vector store with the wrong candidate set, no fetch-then-discard round trips.

### 6h. `searchDocuments` — putting it all together

The MCP server in Step 7 calls a single `searchDocuments` function. Here's the implementation that ties the modes together:

```typescript
// search.ts
import postgres from 'postgres';
import { embed } from 'ai';
import { openai } from '@ai-sdk/openai';

const sql = postgres(process.env.DATABASE_URL!);
const embeddingModel = openai.textEmbeddingModel('text-embedding-3-small');

interface SearchParams {
  semantic?: string;                // natural language query
  fulltext?: string;                // BM25 query
  tree?: string;                    // ltree filter
  meta?: Record<string, unknown>;   // JSONB containment
  near?: { lon: number; lat: number; radiusMeters: number };  // geo filter
  limit?: number;                   // final result count (default 10)
  candidateLimit?: number;          // per-mode candidates before fusion (default 30)
  semanticThreshold?: number;       // min cosine similarity (0-1)
  weights?: { fulltext?: number; semantic?: number };
}

interface SearchResult {
  id: string;
  content: string;
  meta: Record<string, unknown>;
  tree: string;
  score: number;
}

export async function searchDocuments(params: SearchParams): Promise<SearchResult[]> {
  const limit = params.limit ?? 10;
  const candidateLimit = params.candidateLimit ?? 30;
  const weights = { fulltext: 1, semantic: 1, ...params.weights };

  // 1. Embed the query text if semantic search is requested
  let queryVec: number[] | undefined;
  if (params.semantic) {
    const { embedding } = await embed({
      model: embeddingModel,
      value: params.semantic,
      maxRetries: 5,
    });
    queryVec = embedding;
  }

  // 2. Pick the search mode
  const wantsBM25 = !!params.fulltext;
  const wantsSemantic = !!queryVec;

  if (wantsBM25 && wantsSemantic) {
    // Hybrid: run both in parallel, fuse with RRF
    const [bm25, semantic] = await Promise.all([
      bm25Search(params.fulltext!, params, candidateLimit),
      semanticSearch(queryVec!, params, candidateLimit),
    ]);

    const fused = rrfFusion(bm25, semantic, 60, weights);
    const topIds = fused.slice(0, limit).map(r => r.id);
    const scoreMap = new Map(fused.map(r => [r.id, r.score]));

    const rows = await fetchByIds(topIds);
    return rows.map(row => ({ ...row, score: scoreMap.get(row.id) ?? 0 }));
  }

  if (wantsBM25)     return bm25Search(params.fulltext!, params, limit);
  if (wantsSemantic) return semanticSearch(queryVec!, params, limit);
  return filterOnly(params, limit);
}

// --- Mode implementations ---

async function bm25Search(query: string, p: SearchParams, limit: number) {
  const filters = buildFilters(p);
  return sql<SearchResult[]>`
    select id, content, meta, tree::text,
           -(content <@> to_bm25query(${query}, 'documents_content_bm25_idx')) as score
    from documents
    where content <@> to_bm25query(${query}, 'documents_content_bm25_idx') < 0
      ${filters}
    order by score desc
    limit ${limit}
  `;
}

async function semanticSearch(vec: number[], p: SearchParams, limit: number) {
  const filters = buildFilters(p);
  const vecLit = `[${vec.join(',')}]`;
  const threshold = p.semanticThreshold ?? 0;
  return sql<SearchResult[]>`
    select id, content, meta, tree::text,
           (1 - (embedding <=> ${vecLit}::halfvec)) as score
    from documents
    where embedding is not null
      and (1 - (embedding <=> ${vecLit}::halfvec)) >= ${threshold}
      ${filters}
    order by embedding <=> ${vecLit}::halfvec
    limit ${limit}
  `;
}

async function filterOnly(p: SearchParams, limit: number) {
  const filters = buildFilters(p);
  // If a geo anchor is given with no text/vector query, sort by distance using
  // the kNN operator — it walks the GiST index in distance order.
  if (p.near) {
    return sql<SearchResult[]>`
      select id, content, meta, tree::text, 1.0::float as score
      from documents
      where geom is not null ${filters}
      order by geom <-> ST_SetSRID(ST_MakePoint(${p.near.lon}, ${p.near.lat}), 4326)
      limit ${limit}
    `;
  }
  return sql<SearchResult[]>`
    select id, content, meta, tree::text, 1.0::float as score
    from documents
    where true ${filters}
    order by created_at desc
    limit ${limit}
  `;
}

// --- Helpers ---

function buildFilters(p: SearchParams) {
  const parts = [];
  if (p.tree)                                   parts.push(sql`and tree <@ ${p.tree}::ltree`);
  if (p.meta && Object.keys(p.meta).length > 0) parts.push(sql`and meta @> ${p.meta}::jsonb`);
  if (p.near) parts.push(sql`
    and ST_DWithin(
      geom::geography,
      ST_SetSRID(ST_MakePoint(${p.near.lon}, ${p.near.lat}), 4326)::geography,
      ${p.near.radiusMeters}
    )`);
  return parts.length > 0 ? sql`${parts}` : sql``;
}

async function fetchByIds(ids: string[]) {
  if (ids.length === 0) return [];
  return sql<SearchResult[]>`
    select id, content, meta, tree::text, 0::float as score
    from documents
    where id = any(${ids}::uuid[])
    order by array_position(${ids}::uuid[], id)
  `;
}

function rrfFusion(
  bm25: { id: string }[],
  semantic: { id: string }[],
  k = 60,
  weights = { fulltext: 1, semantic: 1 },
) {
  const scores = new Map<string, number>();
  bm25.forEach((r, i)     => scores.set(r.id, (scores.get(r.id) ?? 0) + weights.fulltext / (k + i + 1)));
  semantic.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + weights.semantic / (k + i + 1)));
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
```

Two details worth flagging:

- **The hybrid path fetches rows twice on purpose.** The two mode queries return whatever columns they need for ranking, but the canonical content is re-pulled via `fetchByIds` in fused order. For small `limit`, the extra roundtrip is negligible — and it keeps the per-mode queries simple and uniform.
- **`array_position` preserves order.** Without it, `where id = any(...)` returns rows in whatever order Postgres pleases, and your carefully computed RRF ranking gets shuffled into PK order. This is the bug everyone hits the first time they write this query.

## Step 7 — Expose it through MCP

Now plug your search into any MCP-capable agent (Claude, Cursor, custom). MCP servers register tools that show up as callable functions to the LLM.

```typescript
// mcp-server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchDocuments } from './search.js';

const server = new McpServer({
  name: 'documents',
  version: '1.0.0',
});

server.registerTool(
  'documents_search',
  {
    title: 'Search Documents',
    description: `Search and browse documents using text matching and/or filters.

Modes: semantic (meaning), fulltext (keywords), or both (hybrid).
For ordinary queries, set both semantic and fulltext to the same query string.
Combine with tree, meta, temporal, and near (geo) filters. Results scored 0-1.`,
    inputSchema: {
      semantic: z.string().optional().nullable()
        .describe('Natural language query for vector search'),
      fulltext: z.string().optional().nullable()
        .describe('Keywords/phrases for BM25'),
      tree: z.string().optional().nullable()
        .describe('Tree filter. work.projects matches exactly; work.projects.* includes descendants'),
      meta: z.record(z.string(), z.any()).optional().nullable()
        .describe('JSONB containment filter'),
      near: z.object({
        lon: z.number(),
        lat: z.number(),
        radiusMeters: z.number(),
      }).optional().nullable()
        .describe('Geo filter: restrict to documents within radiusMeters of (lon, lat). With no other query, results are sorted by distance.'),
      limit: z.number().int().optional().nullable()
        .describe('Maximum results (default 10, max 1000)'),
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
  },
  async (args) => {
    const results = await searchDocuments({
      semantic: args.semantic ?? undefined,
      fulltext: args.fulltext ?? undefined,
      tree: args.tree ?? undefined,
      meta: args.meta ?? undefined,
      near: args.near ?? undefined,
      limit: args.limit && args.limit > 0 ? args.limit : 10,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  },
);

await server.connect(new StdioServerTransport());
```

Three details that matter:

- **All inputs are optional and nullable.** The MCP SDK has historically struggled with strict schemas. Make every field `.optional().nullable()` and unwrap `null → undefined` in the handler. Saves hours of debugging.
- **`readOnlyHint: true` and `idempotentHint: true`** let the host (Claude, Cursor) batch and cache calls and skip permission prompts.
- **Write a long description.** This is the only documentation the LLM reads to decide whether to call your tool. List the modes, the filter syntax, the score scale. The model's tool-selection quality is roughly proportional to description quality.

Wire up the MCP server in your client's config (e.g. `~/.config/claude/mcp.json`) and the agent can now retrieve from your database.

For write operations (insert/update/delete), register additional tools with `readOnlyHint: false`. Be cautious about how aggressive you make destructive operations — most production setups make delete require an explicit ID, never a query.

## What you got

In a single Postgres table:

- Full-text + semantic + hybrid search with first-class scoring
- JSONB, hierarchical-path, temporal-range, and geospatial filters that compose with search
- Index-backed nearest-neighbor queries via PostGIS `<->`
- Asynchronous embedding generation that survives crashes, races, and rate limits
- A transactional guarantee — writes don't depend on the embedding provider being up
- A scaleable worker pool with no coordination overhead (just run more processes)
- An MCP interface that any modern AI client can plug into

No Pinecone bill, no Elasticsearch cluster, no Kafka, no separate sync code. Just `documents`.

## Going further

A few avenues once the basics are in:

- **Chunking.** This post stores whole documents per row. For long content, chunk first (semantic, sliding-window, or markdown-aware) and store one row per chunk, with `meta->>'parent_id'` linking back to the source. Search retrieves chunks; the LLM gets context around them.
- **Re-ranking.** RRF gets you to a strong top-N. For the last mile, pipe the top 30-50 through a cross-encoder (cohere/rerank, voyage rerank, BGE-reranker) before returning the top 10.
- **Multiple embedding columns.** If you want to swap embedding models without losing the old ones, add `embedding_large halfvec(3072)` for `text-embedding-3-large` and a parallel version counter. The worker reads both columns; search picks one. Bonus: zero-downtime migrations.
- **Row-level security.** Add an `owner_id uuid` column, RLS policies keyed on `current_setting('app.user_id')`, and you have per-user retrieval for free. The vector and BM25 indexes still apply.
- **Sharding.** When the table grows past a billion rows, partition by `tree` (one partition per top-level label) or by hash of `id`. HNSW indexes are per-partition and the planner handles the union.
- **Streaming updates.** If you replace an entire knowledge base nightly, do it inside a single transaction: INSERT new rows, then DELETE old. The queue triggers fire only on committed rows, so you never expose half-loaded state to search.

The single-table design is the leverage point. Once you accept that `meta` + `tree` + `temporal` can express every cross-cutting concern in your domain, everything downstream simplifies.
