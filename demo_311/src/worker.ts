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
      await sql`update embedding_queue set outcome = 'cancelled' where id = ${row.queue_id}`;
    } else {
      await sql`update embedding_queue set outcome = 'completed' where id = ${row.queue_id}`;
    }
  }
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
