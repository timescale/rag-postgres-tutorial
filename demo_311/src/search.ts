// search.ts — the searchDocuments implementation from Step 6h of the tutorial.
// Translated as closely as possible. Differences from the tutorial are flagged
// with `// TUTORIAL ISSUE` comments and also recorded in TUTORIAL_ISSUES.md.

import './env.js';
import postgres from 'postgres';
import { embed } from 'ai';
import { openai } from '@ai-sdk/openai';

const sql = postgres(process.env.DATABASE_URL!, { max: 4 });
const embeddingModel = openai.textEmbeddingModel('text-embedding-3-small');

export interface SearchParams {
  semantic?: string;
  fulltext?: string;
  tree?: string;
  meta?: Record<string, unknown>;
  temporal?: { from?: string; to?: string };  // ISO timestamps; overlap with this range
  near?: { lon: number; lat: number; radiusMeters: number };
  limit?: number;
  candidateLimit?: number;
  semanticThreshold?: number;
  weights?: { fulltext?: number; semantic?: number };
}

export interface SearchResult {
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

  let queryVec: number[] | undefined;
  if (params.semantic) {
    const { embedding } = await embed({
      model: embeddingModel,
      value: params.semantic,
      maxRetries: 5,
    });
    queryVec = embedding;
  }

  const wantsBM25 = !!params.fulltext;
  const wantsSemantic = !!queryVec;

  if (wantsBM25 && wantsSemantic) {
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
  return sql<SearchResult[]>`
    select id, content, meta, tree::text as tree,
           -(content <@> to_bm25query(${query}, 'documents_content_bm25_idx')) as score
    from documents
    where content <@> to_bm25query(${query}, 'documents_content_bm25_idx') < 0
      ${treeFilter(p)}
      ${metaFilter(p)}
      ${temporalFilter(p)}
      ${nearFilter(p)}
    order by score desc
    limit ${limit}
  `;
}

async function semanticSearch(vec: number[], p: SearchParams, limit: number) {
  const vecLit = `[${vec.join(',')}]`;
  const threshold = p.semanticThreshold ?? 0;
  return sql<SearchResult[]>`
    select id, content, meta, tree::text as tree,
           (1 - (embedding <=> ${vecLit}::halfvec)) as score
    from documents
    where embedding is not null
      and (1 - (embedding <=> ${vecLit}::halfvec)) >= ${threshold}
      ${treeFilter(p)}
      ${metaFilter(p)}
      ${temporalFilter(p)}
      ${nearFilter(p)}
    order by embedding <=> ${vecLit}::halfvec
    limit ${limit}
  `;
}

async function filterOnly(p: SearchParams, limit: number) {
  if (p.near) {
    const { lon, lat } = p.near;
    return sql<SearchResult[]>`
      select id, content, meta, tree::text as tree, 1.0::float as score
      from documents
      where geom is not null
        ${treeFilter(p)}
        ${metaFilter(p)}
        ${temporalFilter(p)}
        ${nearFilter(p)}
      order by geom <-> ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)
      limit ${limit}
    `;
  }
  return sql<SearchResult[]>`
    select id, content, meta, tree::text as tree, 1.0::float as score
    from documents
    where true
      ${treeFilter(p)}
      ${metaFilter(p)}
      ${temporalFilter(p)}
      ${nearFilter(p)}
    order by created_at desc
    limit ${limit}
  `;
}

// --- Filter fragments ---
// Each returns a `sql` fragment that is either empty or an `and …` predicate.

function treeFilter(p: SearchParams) {
  if (!p.tree) return sql``;
  return sql`and tree <@ ${p.tree}::ltree`;
}

function metaFilter(p: SearchParams) {
  if (!p.meta || Object.keys(p.meta).length === 0) return sql``;
  // postgres-js auto-serializes objects to JSON when cast to ::jsonb.
  // Calling JSON.stringify() ourselves double-encodes (the JSON becomes a
  // quoted string value), so pass the object directly.
  return sql`and meta @> ${p.meta as any}::jsonb`;
}

function temporalFilter(p: SearchParams) {
  if (!p.temporal) return sql``;
  const { from, to } = p.temporal;
  if (from && to) return sql`and temporal && tstzrange(${from}::timestamptz, ${to}::timestamptz, '[)')`;
  if (from)       return sql`and upper(temporal) > ${from}::timestamptz`;
  if (to)         return sql`and lower(temporal) < ${to}::timestamptz`;
  return sql``;
}

function nearFilter(p: SearchParams) {
  if (!p.near) return sql``;
  const { lon, lat, radiusMeters } = p.near;
  return sql`and ST_DWithin(
    geom::geography,
    ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography,
    ${radiusMeters}
  )`;
}

async function fetchByIds(ids: string[]) {
  if (ids.length === 0) return [];
  return sql<SearchResult[]>`
    select id, content, meta, tree::text as tree, 0::float as score
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

export { sql as searchSql };
