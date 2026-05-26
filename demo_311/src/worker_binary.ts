// Worker variant: binary COPY writeback. Same claim/embed loop as worker.ts;
// the writeback uses a temp table + binary COPY + UPDATE FROM.
import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';
import postgres from 'postgres';
import { encodeBatchBinaryCopy, BatchRow } from './halfvec_binary.js';

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
const model = openai.embeddingModel('text-embedding-3-small');

const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 128);
const ONE_SHOT = process.env.ONE_SHOT === '1';
const DIM = 1536;

type ClaimedRow = {
  queue_id: string;
  document_id: string;
  embedding_version: number;
  content: string;
};

let totalProcessed = 0;
const t0 = Date.now();

async function processBatch(): Promise<number> {
  const tClaim = Date.now();
  const claimed = await sql<ClaimedRow[]>`
    select queue_id, document_id, embedding_version, content
    from claim_embedding_batch(${BATCH_SIZE}::int, '5 minutes'::interval)
  `;
  if (claimed.length === 0) {
    try { await sql`select prune_embedding_queue('7 days'::interval)`; }
    catch (err) { console.warn('prune failed', err); }
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

  const rows: BatchRow[] = claimed.map((c, i) => ({
    queueId: BigInt(c.queue_id),
    docId: c.document_id,
    version: c.embedding_version,
    embedding: embeddings[i],
  }));
  const buf = encodeBatchBinaryCopy(rows, DIM);

  const tWrite = Date.now();
  await sql.begin(async tx => {
    await tx`
      create temp table _emb_update (
        q_id bigint, doc_id uuid, ver int, vec halfvec(${tx.unsafe(String(DIM))})
      ) on commit drop
    `;
    const writable = await tx`copy _emb_update from stdin with (format binary)`.writable();
    await new Promise<void>((resolve, reject) => {
      writable.on('error', reject);
      writable.on('finish', () => resolve());
      writable.end(buf);
    });
    await tx`
      with upd as (
        update documents d
           set embedding = e.vec
          from _emb_update e
         where d.id = e.doc_id and d.embedding_version = e.ver
        returning d.id, e.q_id
      )
      update embedding_queue eq
         set outcome = case when upd.q_id is null then 'cancelled' else 'completed' end
        from _emb_update e
        left join upd on upd.q_id = e.q_id
       where eq.id = e.q_id
    `;
  });
  const tWriteEnd = Date.now();

  totalProcessed += claimed.length;
  console.log(
    `batch: claimed=${claimed.length} ` +
    `claim=${tClaimEnd - tClaim}ms ` +
    `embed=${tEmbedEnd - tEmbed}ms ` +
    `write=${tWriteEnd - tWrite}ms ` +
    `(total ${totalProcessed} in ${((Date.now() - t0) / 1000).toFixed(1)}s, ` +
    `${(totalProcessed / Math.max(1, (Date.now() - t0) / 1000)).toFixed(1)}/s, ` +
    `payload ${(buf.length / 1024).toFixed(0)} KB)`
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
  console.log(`\nbinary-copy worker done: ${totalProcessed} embeddings in ${elapsed.toFixed(1)}s (${(totalProcessed / Math.max(1, elapsed)).toFixed(1)}/s)`);
  await sql.end();
}

await run();
