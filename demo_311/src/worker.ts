// Embedding worker — drains embedding_queue, calls OpenAI in batches,
// writes back version-guarded. Lifted from Step 5 of the tutorial with the
// same shape: claim → embed → bulk writeback in one UNNEST update.

import { setTimeout as sleep } from 'node:timers/promises';
import { embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';
import { sql } from './db.js';

const model = openai.embeddingModel('text-embedding-3-small');
const BATCH = 128;

type ClaimedRow = {
  queue_id: string;
  document_id: string;
  embedding_version: number;
  content: string;
};

interface BatchTiming {
  claimMs: number;
  embedMs: number;
  writebackMs: number;
  totalMs: number;
  rows: number;
}

async function processBatch(): Promise<BatchTiming | null> {
  // 1. Claim
  const claimStart = Date.now();
  const claimed = await sql<ClaimedRow[]>`
    select queue_id, document_id, embedding_version, content
    from claim_embedding_batch(${BATCH}::int, '5 minutes'::interval)
  `;
  const claimMs = Date.now() - claimStart;

  if (claimed.length === 0) {
    try {
      await sql`select prune_embedding_queue('7 days'::interval)`;
    } catch (err) {
      console.warn('prune failed', err);
    }
    return null;
  }

  // 2. Embed (one HTTP call, SDK handles 429s)
  const embedStart = Date.now();
  const { embeddings } = await embedMany({
    model,
    values: claimed.map(r => r.content),
    maxRetries: 5,
  });
  const embedMs = Date.now() - embedStart;

  // 3. Bulk writeback in one statement.
  const writeStart = Date.now();
  const ids      = claimed.map(r => r.document_id);
  const versions = claimed.map(r => r.embedding_version);
  const queueIds = claimed.map(r => r.queue_id);
  const vecs     = embeddings.map(e => `[${e.join(',')}]`);

  await sql`
    with input as (
      select * from unnest(
        ${ids}::uuid[], ${versions}::int[], ${queueIds}::bigint[], ${vecs}::text[]
      ) as t(doc_id, ver, q_id, vec)
    ),
    upd as (
      update documents d
         set embedding = i.vec::halfvec
        from input i
       where d.id = i.doc_id and d.embedding_version = i.ver
      returning d.id, i.q_id
    )
    update embedding_queue eq
       set outcome = case when upd.q_id is null then 'cancelled' else 'completed' end
      from input i
      left join upd on upd.q_id = i.q_id
     where eq.id = i.q_id
  `;
  const writebackMs = Date.now() - writeStart;

  return {
    claimMs,
    embedMs,
    writebackMs,
    totalMs: claimMs + embedMs + writebackMs,
    rows: claimed.length,
  };
}

async function run({ oneShot = false } = {}) {
  let totalRows = 0;
  let totalEmbedMs = 0;
  let totalClaimMs = 0;
  let totalWritebackMs = 0;
  let batches = 0;
  const startWall = Date.now();

  while (true) {
    const r = await processBatch();
    if (r === null) {
      if (oneShot) break;
      await sleep(10_000);
      continue;
    }
    batches += 1;
    totalRows += r.rows;
    totalClaimMs += r.claimMs;
    totalEmbedMs += r.embedMs;
    totalWritebackMs += r.writebackMs;
    console.log(
      `batch ${batches}: ${r.rows} rows | claim ${r.claimMs}ms | embed ${r.embedMs}ms | writeback ${r.writebackMs}ms | total ${r.totalMs}ms`,
    );
  }

  if (totalRows > 0) {
    const wall = (Date.now() - startWall) / 1000;
    console.log('--- summary ---');
    console.log(`batches:      ${batches}`);
    console.log(`rows:         ${totalRows}`);
    console.log(`wall:         ${wall.toFixed(2)}s`);
    console.log(`throughput:   ${(totalRows / wall).toFixed(1)} rows/s`);
    console.log(`avg claim:    ${(totalClaimMs / batches).toFixed(0)}ms / batch`);
    console.log(`avg embed:    ${(totalEmbedMs / batches).toFixed(0)}ms / batch`);
    console.log(`avg writeback:${(totalWritebackMs / batches).toFixed(0)}ms / batch`);
  } else {
    console.log('queue empty, nothing to do');
  }
}

const oneShot = process.argv.includes('--oneshot');
run({ oneShot })
  .then(() => sql.end())
  .catch(async err => {
    console.error(err);
    await sql.end();
    process.exit(1);
  });
