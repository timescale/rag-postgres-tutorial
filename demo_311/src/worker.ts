// Embedding worker — claims batches from embedding_queue, generates embeddings
// via the OpenAI batch endpoint, writes them back to documents with a
// version-guarded UPDATE. Multiple instances can run in parallel; SKIP LOCKED
// ensures they don't step on each other.
//
// Exits after one drain pass when DRAIN_THEN_EXIT=1 (used for timing runs).

import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { max: 4 });
const model = openai.textEmbeddingModel('text-embedding-3-small');

const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 64);
const DRAIN_THEN_EXIT = process.env.DRAIN_THEN_EXIT === '1';

interface ClaimedRow {
  queue_id: string; // bigint comes back as string in postgres.js by default
  document_id: string;
  embedding_version: number;
  content: string;
}

async function processBatch(): Promise<number> {
  const claimed = await sql<ClaimedRow[]>`
    select queue_id, document_id, embedding_version, content
    from claim_embedding_batch(${BATCH_SIZE}::int, '5 minutes'::interval)
  `;
  if (claimed.length === 0) return 0;

  const tEmbed = Date.now();
  const { embeddings } = await embedMany({
    model,
    values: claimed.map(r => r.content),
    maxRetries: 5,
  });
  const dtEmbed = Date.now() - tEmbed;

  const tWrite = Date.now();
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
  const dtWrite = Date.now() - tWrite;

  console.log(
    `batch=${claimed.length} embed=${dtEmbed}ms write=${dtWrite}ms ` +
    `rate=${Math.round((claimed.length / (dtEmbed + dtWrite)) * 1000)} rows/s`
  );
  return claimed.length;
}

async function run() {
  const t0 = Date.now();
  let total = 0;
  while (true) {
    const n = await processBatch();
    total += n;
    if (n === 0) {
      if (DRAIN_THEN_EXIT) break;
      await sleep(10_000);
      continue;
    }
  }
  const dt = Date.now() - t0;
  console.log(`Drained ${total} rows in ${(dt / 1000).toFixed(2)}s (${(total / (dt / 1000)).toFixed(1)} rows/s avg)`);
  await sql.end();
}

run().catch(async err => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
