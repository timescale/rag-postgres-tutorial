// Embedding worker — drains the embedding_queue.
// Translated as closely as possible from the tutorial's Step 5 pseudocode.

import './env.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const sql = postgres(DATABASE_URL, { max: 4 });
const model = openai.textEmbeddingModel('text-embedding-3-small');

const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 64);
const LOCK = process.env.LOCK_DURATION ?? '5 minutes';

type ClaimRow = {
  queue_id: string;       // bigint comes back as string from postgres-js
  document_id: string;
  embedding_version: number;
  content: string;
};

async function processBatch(): Promise<number> {
  const claimed = await sql<ClaimRow[]>`
    select * from claim_embedding_batch(${BATCH_SIZE}, ${LOCK}::interval)
  `;
  if (claimed.length === 0) return 0;

  const { embeddings } = await embedMany({
    model,
    values: claimed.map(r => r.content),
    maxRetries: 5,
  });

  // Bulk writeback — one round trip for the whole batch. See TUTORIAL_ISSUES #2.
  const ids       = claimed.map(r => r.document_id);
  const versions  = claimed.map(r => r.embedding_version);
  const queueIds  = claimed.map(r => r.queue_id);
  const vecs      = embeddings.map(e => `[${e.join(',')}]`);

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
  return claimed.length;
}

async function run() {
  console.log(`Worker started. batch=${BATCH_SIZE}, lock=${LOCK}`);
  let totalDone = 0;
  while (true) {
    try {
      const n = await processBatch();
      if (n === 0) {
        const [{ remaining }] = await sql<[{ remaining: number }]>`
          select count(*)::int as remaining from embedding_queue where outcome is null and vt <= now()
        `;
        if (remaining === 0 && process.env.EXIT_WHEN_DONE === '1') {
          console.log(`No more work. Total embedded this run: ${totalDone}. Exiting.`);
          break;
        }
        await sleep(10_000);
      } else {
        totalDone += n;
        console.log(`  embedded ${n} (running total ${totalDone})`);
      }
    } catch (e) {
      console.error('batch failed:', e);
      await sleep(2_000);
    }
  }
  await sql.end();
}

run().catch(err => { console.error(err); process.exit(1); });
