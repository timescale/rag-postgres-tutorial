import 'dotenv/config';
import postgres from 'postgres';
import { embed } from 'ai';
import { openai } from '@ai-sdk/openai';

const sql = postgres(process.env.DATABASE_URL!, { max: 4 });
const embeddingModel = openai.embeddingModel('text-embedding-3-small');

export interface SearchParams {
  semantic?: string;
  fulltext?: string;
  tree?: string;
  meta?: Record<string, any>;
  temporal?: { from?: string; to?: string };
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
  meters?: number;  // populated whenever `near` is set
}

// Build a list of sql-fragment AND-conditions. postgres.js accepts a
// Fragment[] interpolated into a sql`` template and concatenates the pieces.
function buildFilters(p: SearchParams) {
  const parts: postgres.Fragment[] = [];
  if (p.tree) parts.push(sql`and tree <@ ${p.tree}::ltree`);
  if (p.meta && Object.keys(p.meta).length > 0) {
    // Use sql.json: postgres.js encodes it as JSONB on the wire. Naive
    // JSON.stringify(...)::jsonb gives Postgres a JSON scalar string,
    // which @> on an object can never match.
    parts.push(sql`and meta @> ${sql.json(p.meta as postgres.JSONValue)}`);
  }
  if (p.temporal) {
    const { from, to } = p.temporal;
    if (from && to)      parts.push(sql`and temporal && tstzrange(${from}::timestamptz, ${to}::timestamptz, '[)')`);
    else if (from)       parts.push(sql`and upper(temporal) > ${from}::timestamptz`);
    else if (to)         parts.push(sql`and lower(temporal) < ${to}::timestamptz`);
  }
  if (p.near) parts.push(sql`
    and ST_DWithin(
      geom::geography,
      ST_SetSRID(ST_MakePoint(${p.near.lon}, ${p.near.lat}), 4326)::geography,
      ${p.near.radiusMeters}
    )`);
  return parts.length > 0 ? sql`${parts}` : sql``;
}

// Whenever `near` is given, project ST_Distance as `meters` so every result
// carries "how far".
function metersProj(p: SearchParams) {
  if (!p.near) return sql``;
  return sql`, ST_Distance(geom::geography,
                           ST_SetSRID(ST_MakePoint(${p.near.lon}, ${p.near.lat}), 4326)::geography
                          ) as meters`;
}

async function bm25Search(query: string, p: SearchParams, limit: number): Promise<SearchResult[]> {
  const filters = buildFilters(p);
  const rows = await sql<SearchResult[]>`
    select id, content, meta, tree::text as tree,
           -(content <@> to_bm25query(${query}, 'documents_content_bm25_idx')) as score
           ${metersProj(p)}
    from documents
    where content <@> to_bm25query(${query}, 'documents_content_bm25_idx') < 0
      ${filters}
    order by score desc, id desc
    limit ${limit}
  `;
  return rows;
}

async function semanticSearch(vec: number[], p: SearchParams, limit: number): Promise<SearchResult[]> {
  const filters = buildFilters(p);
  const vecLit = `[${vec.join(',')}]`;
  const threshold = p.semanticThreshold ?? 0;
  const rows = await sql<SearchResult[]>`
    select id, content, meta, tree::text as tree,
           (1 - (embedding <=> ${vecLit}::halfvec)) as score
           ${metersProj(p)}
    from documents
    where embedding is not null
      and (1 - (embedding <=> ${vecLit}::halfvec)) >= ${threshold}
      ${filters}
    order by embedding <=> ${vecLit}::halfvec, id desc
    limit ${limit}
  `;
  return rows;
}

async function filterOnly(p: SearchParams, limit: number): Promise<SearchResult[]> {
  const filters = buildFilters(p);
  if (p.near) {
    return sql<SearchResult[]>`
      select id, content, meta, tree::text as tree, 1.0::float as score
             ${metersProj(p)}
      from documents
      where geom is not null ${filters}
      order by geom <-> ST_SetSRID(ST_MakePoint(${p.near.lon}, ${p.near.lat}), 4326)
      limit ${limit}
    `;
  }
  return sql<SearchResult[]>`
    select id, content, meta, tree::text as tree, 1.0::float as score
    from documents
    where true ${filters}
    order by id desc
    limit ${limit}
  `;
}

async function fetchByIds(ids: string[], p: SearchParams): Promise<SearchResult[]> {
  if (ids.length === 0) return [];
  return sql<SearchResult[]>`
    select id, content, meta, tree::text as tree, 0::float as score
           ${metersProj(p)}
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
  bm25.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + weights.fulltext / (k + i + 1)));
  semantic.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + weights.semantic / (k + i + 1)));
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
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
    const rows = await fetchByIds(topIds, params);
    return rows.map(row => ({ ...row, score: scoreMap.get(row.id) ?? 0 }));
  }
  if (wantsBM25)     return bm25Search(params.fulltext!, params, limit);
  if (wantsSemantic) return semanticSearch(queryVec!, params, limit);
  return filterOnly(params, limit);
}

export { sql };
