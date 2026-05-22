// Worker: claims a batch of pending embedding jobs, calls OpenAI to embed,
// writes the embeddings back, finalizes the queue rows.
//
// Code transplanted as faithfully as possible from blog_rag_tutorial.md Step 5.
import { setTimeout as sleep } from 'node:timers/promises';
import { embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';
import postgres from 'postgres';
import { DATABASE_URL } from './env.js';

const sql = postgres(DATABASE_URL);
const model = openai.textEmbeddingModel('text-embedding-3-small');

interface ClaimedRow {
  queue_id: string;
  document_id: string;
  embedding_version: number;
  content: string;
}

async function processBatch(): Promise<number> {
  // 1. Claim
  const claimed = await sql<ClaimedRow[]>`
    select * from claim_embedding_batch(50, '5 minutes'::interval)
  `;
  if (claimed.length === 0) return 0;

  // 2. Embed (one HTTP call for the whole batch).
  const { embeddings } = await embedMany({
    model,
    values: claimed.map(r => r.content),
    maxRetries: 5,
  });

  // 3. Bulk writeback in one round trip, version-guarded.
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
  console.log('worker started');
  let totalProcessed = 0;
  let idleLoops = 0;
  while (true) {
    try {
      const n = await processBatch();
      if (n === 0) {
        idleLoops++;
        // Exit after 3 idle loops (~30s) — useful for a one-shot backfill run.
        if (process.env.EXIT_WHEN_IDLE === '1' && idleLoops >= 3) {
          console.log(`done. processed ${totalProcessed} embeddings.`);
          await sql.end();
          return;
        }
        await sleep(10_000);
      } else {
        totalProcessed += n;
        idleLoops = 0;
        console.log(`processed ${n} (total ${totalProcessed})`);
      }
    } catch (err) {
      console.error('batch failed:', err);
      await sleep(5_000);
    }
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
