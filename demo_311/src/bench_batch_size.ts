// A/B the worker across BATCH_SIZE values. For each size:
//   1. Re-enqueue a fresh N rows (by editing content, which bumps version & nulls embedding).
//   2. Drain via processBatch loop with that BATCH_SIZE.
//   3. Record per-batch claim/embed/write timings + total.
import 'dotenv/config';
import { embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
const model = openai.embeddingModel('text-embedding-3-small');

const N_PER_TEST = 256;
const SIZES = [32, 64, 128, 256];

type ClaimedRow = { queue_id: string; document_id: string; embedding_version: number; content: string };

async function reenqueue(n: number, offsetMarker: number) {
  // Bump `n` rows we haven't touched yet in this run. Use a per-run marker so
  // each test edits a fresh slice without overlap.
  const tag = ` [BENCH${offsetMarker}]`;
  await sql`
    with picked as (
      select id from documents order by id offset ${offsetMarker * n} limit ${n}
    )
    update documents d
    set content = d.content || ${tag}
    from picked p
    where d.id = p.id
  `;
  const [{ open }] = await sql<{ open: string }[]>`
    select count(*)::text as open from embedding_queue where outcome is null
  `;
  return Number(open);
}

async function processOnce(batchSize: number) {
  const tClaim = Date.now();
  const claimed = await sql<ClaimedRow[]>`
    select queue_id, document_id, embedding_version, content
    from claim_embedding_batch(${batchSize}::int, '5 minutes'::interval)
  `;
  const tClaimEnd = Date.now();
  if (claimed.length === 0) return null;

  const tEmbed = Date.now();
  const { embeddings } = await embedMany({
    model,
    values: claimed.map(r => r.content),
    maxRetries: 5,
  });
  const tEmbedEnd = Date.now();

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
  return {
    n: claimed.length,
    claim: tClaimEnd - tClaim,
    embed: tEmbedEnd - tEmbed,
    write: tWriteEnd - tWrite,
  };
}

async function runOne(batchSize: number, marker: number) {
  const open = await reenqueue(N_PER_TEST, marker);
  console.log(`\n[BATCH_SIZE=${batchSize}] queue open=${open}`);
  const t0 = Date.now();
  let processed = 0;
  let claimSum = 0, embedSum = 0, writeSum = 0, batches = 0;
  for (;;) {
    const r = await processOnce(batchSize);
    if (!r) break;
    processed += r.n;
    claimSum += r.claim; embedSum += r.embed; writeSum += r.write; batches++;
    console.log(`  batch ${batches}: n=${r.n} claim=${r.claim}ms embed=${r.embed}ms write=${r.write}ms`);
  }
  const elapsed = Date.now() - t0;
  console.log(
    `  -> ${processed} docs in ${(elapsed / 1000).toFixed(2)}s = ${(processed / (elapsed / 1000)).toFixed(1)}/s ` +
    `(${batches} batches; sum claim=${claimSum}ms embed=${embedSum}ms write=${writeSum}ms)`
  );
  return { batchSize, processed, elapsed, batches, claimSum, embedSum, writeSum };
}

async function main() {
  const results = [];
  for (let i = 0; i < SIZES.length; i++) {
    results.push(await runOne(SIZES[i], i));
  }
  console.log('\n=== SUMMARY ===');
  console.log('size  total(s)  rate(/s)  batches  claim(s)  embed(s)  write(s)');
  for (const r of results) {
    console.log(
      `${String(r.batchSize).padStart(4)}  ` +
      `${(r.elapsed / 1000).toFixed(2).padStart(8)}  ` +
      `${(r.processed / (r.elapsed / 1000)).toFixed(1).padStart(8)}  ` +
      `${String(r.batches).padStart(7)}  ` +
      `${(r.claimSum / 1000).toFixed(2).padStart(8)}  ` +
      `${(r.embedSum / 1000).toFixed(2).padStart(8)}  ` +
      `${(r.writeSum / 1000).toFixed(2).padStart(8)}`
    );
  }
  await sql.end();
}

await main();
