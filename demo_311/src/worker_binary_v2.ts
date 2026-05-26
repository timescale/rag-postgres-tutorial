// Worker variant: binary COPY writeback with a reserved connection + persistent
// temp table, to avoid BEGIN/CREATE TEMP/COMMIT overhead per batch.
//
// Per batch on the reserved connection:
//   1. TRUNCATE _emb_staging
//   2. COPY _emb_staging FROM STDIN WITH BINARY
//   3. UPDATE documents + UPDATE embedding_queue in one CTE statement
import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';
import postgres from 'postgres';
import { encodeBatchBinaryCopy, BatchRow } from './halfvec_binary.js';

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {}, max: 4 });
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

async function run() {
  // Reserve a dedicated connection so the temp table persists across batches.
  const conn = await sql.reserve();
  try {
    await conn`
      create temp table _emb_staging (
        q_id bigint, doc_id uuid, ver int, vec halfvec(${conn.unsafe(String(DIM))})
      )
    `;

    while (true) {
      const tClaim = Date.now();
      const claimed = await conn<ClaimedRow[]>`
        select queue_id, document_id, embedding_version, content
        from claim_embedding_batch(${BATCH_SIZE}::int, '5 minutes'::interval)
      `;
      const tClaimEnd = Date.now();

      if (claimed.length === 0) {
        if (ONE_SHOT) break;
        await sleep(10_000);
        continue;
      }

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
      await conn`truncate _emb_staging`;
      const writable = await conn`copy _emb_staging from stdin with (format binary)`.writable();
      await new Promise<void>((resolve, reject) => {
        writable.on('error', reject);
        writable.on('finish', () => resolve());
        writable.end(buf);
      });
      await conn`
        with upd as (
          update documents d
             set embedding = e.vec
            from _emb_staging e
           where d.id = e.doc_id and d.embedding_version = e.ver
          returning d.id, e.q_id
        )
        update embedding_queue eq
           set outcome = case when upd.q_id is null then 'cancelled' else 'completed' end
          from _emb_staging e
          left join upd on upd.q_id = e.q_id
         where eq.id = e.q_id
      `;
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
    }
  } finally {
    conn.release();
  }
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`\nbinary-copy-v2 worker done: ${totalProcessed} embeddings in ${elapsed.toFixed(1)}s (${(totalProcessed / Math.max(1, elapsed)).toFixed(1)}/s)`);
  await sql.end();
}

await run();
