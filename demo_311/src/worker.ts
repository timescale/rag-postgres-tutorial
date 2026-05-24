// Worker, per Step 5 of the tutorial. Polls claim_embedding_batch, calls
// OpenAI embeddings, writes back version-guarded in a single statement.
// We exit when the queue drains so this script can act as both a one-shot
// backfiller for the demo and a long-running worker in production.
import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);
const model = openai.embeddingModel('text-embedding-3-small');

type ClaimedRow = {
  queue_id: string;
  document_id: string;
  embedding_version: number;
  content: string;
};

const BATCH = 64;
const IDLE_EXIT_AFTER_MS = 5_000;

const stats = {
  batches: 0,
  rows: 0,
  embedMs: 0,
  writeMs: 0,
  claimMs: 0,
};

async function processBatch(): Promise<number> {
  const tClaim = performance.now();
  const claimed = await sql<ClaimedRow[]>`
    select queue_id, document_id, embedding_version, content
    from claim_embedding_batch(${BATCH}, '5 minutes'::interval)
  `;
  stats.claimMs += performance.now() - tClaim;
  if (claimed.length === 0) return 0;

  const tEmbed = performance.now();
  const { embeddings } = await embedMany({
    model,
    values: claimed.map(r => r.content),
    maxRetries: 5,
  });
  stats.embedMs += performance.now() - tEmbed;

  const ids       = claimed.map(r => r.document_id);
  const versions  = claimed.map(r => r.embedding_version);
  const queueIds  = claimed.map(r => r.queue_id);
  const vecs      = embeddings.map(e => `[${e.join(',')}]`);

  const tWrite = performance.now();
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
  stats.writeMs += performance.now() - tWrite;

  stats.batches++;
  stats.rows += claimed.length;
  return claimed.length;
}

async function run() {
  let idleSince: number | null = null;
  const t0 = performance.now();
  while (true) {
    const n = await processBatch();
    if (n === 0) {
      if (idleSince === null) idleSince = performance.now();
      if (performance.now() - idleSince > IDLE_EXIT_AFTER_MS) break;
      await sleep(500);
    } else {
      idleSince = null;
      const elapsed = (performance.now() - t0) / 1000;
      console.log(
        `batch ${stats.batches}: +${n} rows total=${stats.rows} (${(stats.rows / elapsed).toFixed(1)} rows/s)`
      );
    }
  }
  const total = (performance.now() - t0) / 1000;
  console.log('---');
  console.log(`done: ${stats.rows} rows in ${total.toFixed(1)}s (${(stats.rows / total).toFixed(1)} rows/s)`);
  console.log(`  claim: ${(stats.claimMs / 1000).toFixed(2)}s total, avg ${(stats.claimMs / stats.batches).toFixed(0)}ms/batch`);
  console.log(`  embed: ${(stats.embedMs / 1000).toFixed(2)}s total, avg ${(stats.embedMs / stats.batches).toFixed(0)}ms/batch`);
  console.log(`  write: ${(stats.writeMs / 1000).toFixed(2)}s total, avg ${(stats.writeMs / stats.batches).toFixed(0)}ms/batch`);
}

await run();
await sql.end();
