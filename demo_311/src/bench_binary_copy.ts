// Compare three writeback strategies for a 128-row batch:
//   A) full-precision text via unnest      (current worker)
//   B) toFixed(5) text via unnest          (cheap precision-trim)
//   C) binary COPY into temp + UPDATE FROM (this script's contribution)
//
// Strategy C should be both fastest AND truly lossless (float16 over the wire =
// exactly what halfvec stores on disk, no text round-trip).
import 'dotenv/config';
import { embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';
import postgres from 'postgres';
import { encodeBatchBinaryCopy, BatchRow } from './halfvec_binary.js';

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
const model = openai.embeddingModel('text-embedding-3-small');

const N = 128;
const DIM = 1536;

async function ensureFreshBatch(): Promise<{ rows: BatchRow[]; vecs: number[][] }> {
  // Bump content on a stable slice of N docs to enqueue fresh jobs.
  await sql`update embedding_queue set outcome = 'cancelled' where outcome is null`;
  await sql`
    with picked as (select id from documents order by id limit ${N})
    update documents d set content = d.content || ' [BCOPY_BENCH]'
    from picked p where d.id = p.id
  `;
  const claimed = await sql<{ queue_id: string; document_id: string; embedding_version: number; content: string }[]>`
    select queue_id, document_id, embedding_version, content
    from claim_embedding_batch(${N}::int, '5 minutes'::interval)
  `;
  if (claimed.length !== N) throw new Error(`claimed ${claimed.length} != ${N}`);
  console.log(`embedding ${N} fresh contents via OpenAI…`);
  const { embeddings: vecs } = await embedMany({ model, values: claimed.map(r => r.content), maxRetries: 5 });
  const rows: BatchRow[] = claimed.map((c, i) => ({
    queueId: BigInt(c.queue_id),
    docId: c.document_id,
    version: c.embedding_version,
    embedding: vecs[i],
  }));
  return { rows, vecs };
}

async function strategyText(rows: BatchRow[], precision: 'full' | 'fixed5') {
  const ids = rows.map(r => r.docId);
  const versions = rows.map(r => r.version);
  const queueIds = rows.map(r => String(r.queueId));
  const vecs = rows.map(r =>
    precision === 'full'
      ? `[${r.embedding.join(',')}]`
      : `[${r.embedding.map(x => x.toFixed(5)).join(',')}]`
  );
  const payloadBytes = vecs.reduce((s, v) => s + v.length, 0);
  const t = Date.now();
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
  return { ms: Date.now() - t, payloadBytes };
}

async function strategyBinaryCopy(rows: BatchRow[]) {
  const tEncode = Date.now();
  const buf = encodeBatchBinaryCopy(rows, DIM);
  const encodeMs = Date.now() - tEncode;
  const payloadBytes = buf.length;

  let copyMs = 0, updMs = 0;
  await sql.begin(async tx => {
    const tCopy = Date.now();
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
    copyMs = Date.now() - tCopy;

    const tUpd = Date.now();
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
    updMs = Date.now() - tUpd;
  });
  return { ms: encodeMs + copyMs + updMs, encodeMs, copyMs, updMs, payloadBytes };
}

async function resetBatch(rows: BatchRow[]) {
  // Null embeddings on the same rows so each strategy starts from the same state.
  const ids = rows.map(r => r.docId);
  await sql`
    update documents set embedding = null
    where id = any(${ids}::uuid[])
  `;
}

async function main() {
  const { rows } = await ensureFreshBatch();
  console.log(`got ${rows.length} rows; vec dim=${rows[0].embedding.length}\n`);

  // Warm connection
  for (let i = 0; i < 3; i++) await sql`select 1`;

  // We're going to run each strategy and immediately reset the embedding to null
  // for the next strategy. Then run each 3 times for stability.
  type R = { label: string; ms: number; payloadKB: number; extra?: string };
  const all: R[] = [];

  for (let round = 1; round <= 3; round++) {
    console.log(`--- round ${round} ---`);

    await resetBatch(rows);
    const a = await strategyText(rows, 'full');
    console.log(`A) full-precision text: ${a.ms}ms (payload ${(a.payloadBytes/1024).toFixed(0)} KB)`);
    all.push({ label: 'A full text', ms: a.ms, payloadKB: a.payloadBytes/1024 });

    await resetBatch(rows);
    const b = await strategyText(rows, 'fixed5');
    console.log(`B) toFixed(5) text:     ${b.ms}ms (payload ${(b.payloadBytes/1024).toFixed(0)} KB)`);
    all.push({ label: 'B fixed5 text', ms: b.ms, payloadKB: b.payloadBytes/1024 });

    await resetBatch(rows);
    const c = await strategyBinaryCopy(rows);
    console.log(`C) binary COPY:         ${c.ms}ms (payload ${(c.payloadBytes/1024).toFixed(0)} KB)  ` +
                `[encode=${c.encodeMs}ms copy=${c.copyMs}ms update=${c.updMs}ms]`);
    all.push({ label: 'C binary copy', ms: c.ms, payloadKB: c.payloadBytes/1024, extra: `encode=${c.encodeMs} copy=${c.copyMs} update=${c.updMs}` });
  }

  console.log(`\n=== summary (median of 3) ===`);
  for (const label of ['A full text', 'B fixed5 text', 'C binary copy']) {
    const xs = all.filter(r => r.label === label).map(r => r.ms).sort((a, b) => a - b);
    const med = xs[1];
    const payload = all.find(r => r.label === label)!.payloadKB;
    console.log(`  ${label.padEnd(15)} median ${String(med).padStart(5)}ms  payload ${payload.toFixed(0).padStart(5)} KB`);
  }

  await sql.end();
}

await main();
