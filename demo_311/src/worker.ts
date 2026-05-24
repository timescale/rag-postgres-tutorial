import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { max: 4 });
const model = openai.embeddingModel('text-embedding-3-small');

const BATCH = 64;
const LOCK = '5 minutes';

type Claimed = {
  queue_id: string;          // bigint comes back as JS string from postgres.js
  document_id: string;
  embedding_version: number;
  content: string;
};

async function processBatch(): Promise<number> {
  const claimed = await sql<Claimed[]>`
    select queue_id, document_id, embedding_version, content
    from claim_embedding_batch(${BATCH}, ${LOCK}::interval)
  `;
  if (claimed.length === 0) return 0;

  const tEmbed = Date.now();
  const { embeddings } = await embedMany({
    model,
    values: claimed.map(r => r.content),
    maxRetries: 5,
  });
  const dtEmbed = Date.now() - tEmbed;

  const ids       = claimed.map(r => r.document_id);
  const versions  = claimed.map(r => r.embedding_version);
  const queueIds  = claimed.map(r => r.queue_id);
  const vecs      = embeddings.map(e => `[${e.join(',')}]`);

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
  const dtWrite = Date.now() - tWrite;

  console.log(`  batch=${claimed.length} embed=${dtEmbed}ms write=${dtWrite}ms`);
  return claimed.length;
}

async function run() {
  const bench = process.argv.includes('--bench');
  let totalProcessed = 0;
  let totalBatches = 0;
  const startTime = Date.now();

  while (true) {
    const t0 = Date.now();
    const n = await processBatch();
    if (n === 0) {
      if (bench) {
        const dt = (Date.now() - startTime) / 1000;
        console.log(`\nBench complete: ${totalProcessed} rows in ${dt.toFixed(2)}s = ${(totalProcessed/dt).toFixed(1)} rows/s (${totalBatches} batches)`);
        await sql.end();
        process.exit(0);
      }
      await sleep(10_000);
      continue;
    }
    totalProcessed += n;
    totalBatches += 1;
    const dt = Date.now() - t0;
    console.log(`batch ${totalBatches}: ${n} rows in ${dt}ms (total ${totalProcessed})`);
  }
}

run().catch(err => { console.error(err); process.exit(1); });
