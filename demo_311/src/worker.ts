// Embedding worker — claims batches, embeds, writes back. Per the tutorial.
import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
const model = openai.embeddingModel('text-embedding-3-small');

type ClaimedRow = {
  queue_id: string;
  document_id: string;
  embedding_version: number;
  content: string;
};

const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 128);
const ONE_SHOT = process.env.ONE_SHOT === '1';

let totalProcessed = 0;
let totalEmbedTimeMs = 0;
let totalRoundTripTimeMs = 0;
const t0 = Date.now();

async function processBatch(): Promise<number> {
  const tClaim = Date.now();
  const claimed = await sql<ClaimedRow[]>`
    select queue_id, document_id, embedding_version, content
    from claim_embedding_batch(${BATCH_SIZE}::int, '5 minutes'::interval)
  `;
  if (claimed.length === 0) {
    try {
      await sql`select prune_embedding_queue('7 days'::interval)`;
    } catch (err) {
      console.warn('prune failed', err);
    }
    return 0;
  }
  const tClaimEnd = Date.now();

  const tEmbed = Date.now();
  const { embeddings } = await embedMany({
    model,
    values: claimed.map(r => r.content),
    maxRetries: 5,
  });
  const tEmbedEnd = Date.now();
  totalEmbedTimeMs += tEmbedEnd - tEmbed;

  const ids = claimed.map(r => r.document_id);
  const versions = claimed.map(r => r.embedding_version);
  const queueIds = claimed.map(r => r.queue_id);
  const vecs = embeddings.map(e => `[${e.join(',')}]`);

  const tWrite = Date.now();
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
  const tWriteEnd = Date.now();
  totalRoundTripTimeMs += (tClaimEnd - tClaim) + (tWriteEnd - tWrite);

  totalProcessed += claimed.length;
  console.log(
    `batch: claimed=${claimed.length} ` +
    `claim=${tClaimEnd - tClaim}ms ` +
    `embed=${tEmbedEnd - tEmbed}ms ` +
    `write=${tWriteEnd - tWrite}ms ` +
    `(total ${totalProcessed} in ${((Date.now() - t0) / 1000).toFixed(1)}s, ` +
    `${(totalProcessed / Math.max(1, (Date.now() - t0) / 1000)).toFixed(1)}/s)`
  );
  return claimed.length;
}

async function run() {
  while (true) {
    const n = await processBatch();
    if (n === 0) {
      if (ONE_SHOT) break;
      await sleep(10_000);
    }
  }
  const elapsed = (Date.now() - t0) / 1000;
  console.log(
    `\nworker done: ${totalProcessed} embeddings in ${elapsed.toFixed(1)}s ` +
    `(${(totalProcessed / Math.max(1, elapsed)).toFixed(1)}/s). ` +
    `embed time ${(totalEmbedTimeMs / 1000).toFixed(1)}s, ` +
    `db roundtrip ${(totalRoundTripTimeMs / 1000).toFixed(1)}s.`
  );
  await sql.end();
}

await run();
