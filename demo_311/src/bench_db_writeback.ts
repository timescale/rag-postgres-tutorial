// Compare DB writeback strategies using SYNTHETIC vectors so we don't depend
// on OpenAI. Same code paths as the real workers; just the embedding step is
// replaced with `Float32` noise. We're isolating the DB roundtrip behavior,
// which is what the worker-pattern question is actually about.
import 'dotenv/config';
import postgres from 'postgres';
import { encodeBatchBinaryCopy, BatchRow } from './halfvec_binary.js';

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {}, max: 4 });

const DIM = 1536;

function fakeVec(): number[] {
  // Unit-ish vector with realistic magnitudes (~1/sqrt(1536) per component).
  const v = new Array<number>(DIM);
  for (let i = 0; i < DIM; i++) v[i] = (Math.random() - 0.5) * 0.05;
  return v;
}

async function bumpAndClaim(n: number) {
  await sql`update embedding_queue set outcome = 'cancelled' where outcome is null`;
  await sql`
    with picked as (select id from documents order by id limit ${n})
    update documents d set content = d.content || ' [BENCH_DB]'
    from picked p where d.id = p.id
  `;
  const claimed = await sql<{ queue_id: string; document_id: string; embedding_version: number }[]>`
    select queue_id, document_id, embedding_version
    from claim_embedding_batch(${n}::int, '5 minutes'::interval)
  `;
  if (claimed.length !== n) throw new Error(`claimed ${claimed.length} != ${n}`);
  return claimed.map(c => ({
    queueId: BigInt(c.queue_id),
    docId: c.document_id,
    version: c.embedding_version,
    embedding: fakeVec(),
  }));
}

async function resetEmbeddingNull(rows: BatchRow[]) {
  const ids = rows.map(r => r.docId);
  await sql`update documents set embedding = null where id = any(${ids}::uuid[])`;
}

async function writeTextUnnest(rows: BatchRow[], precision: 'full' | 'fixed4' | 'fixed5'): Promise<number> {
  const ids = rows.map(r => r.docId);
  const versions = rows.map(r => r.version);
  const queueIds = rows.map(r => String(r.queueId));
  const vecs = rows.map(r =>
    precision === 'full'   ? `[${r.embedding.join(',')}]` :
    precision === 'fixed5' ? `[${r.embedding.map(x => x.toFixed(5)).join(',')}]` :
                             `[${r.embedding.map(x => x.toFixed(4)).join(',')}]`
  );
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
  return Date.now() - t;
}

async function writeBinaryCopyTxn(rows: BatchRow[]): Promise<number> {
  const buf = encodeBatchBinaryCopy(rows, DIM);
  const t = Date.now();
  await sql.begin(async tx => {
    await tx`create temp table _emb_update (q_id bigint, doc_id uuid, ver int, vec halfvec(${tx.unsafe(String(DIM))})) on commit drop`;
    const writable = await tx`copy _emb_update from stdin with (format binary)`.writable();
    await new Promise<void>((resolve, reject) => {
      writable.on('error', reject);
      writable.on('finish', () => resolve());
      writable.end(buf);
    });
    await tx`
      with upd as (
        update documents d set embedding = e.vec
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
  return Date.now() - t;
}

async function writeBinaryCopyReserved(rows: BatchRow[]): Promise<number> {
  const buf = encodeBatchBinaryCopy(rows, DIM);
  const conn = await sql.reserve();
  try {
    await conn`create temp table if not exists _emb_staging (q_id bigint, doc_id uuid, ver int, vec halfvec(${conn.unsafe(String(DIM))}))`;
    const t = Date.now();
    await conn`truncate _emb_staging`;
    const writable = await conn`copy _emb_staging from stdin with (format binary)`.writable();
    await new Promise<void>((resolve, reject) => {
      writable.on('error', reject);
      writable.on('finish', () => resolve());
      writable.end(buf);
    });
    await conn`
      with upd as (
        update documents d set embedding = e.vec
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
    return Date.now() - t;
  } finally {
    conn.release();
  }
}

async function bench(label: string, batchSize: number, fn: (rows: BatchRow[]) => Promise<number>) {
  // Three rounds for stability
  const rows = await bumpAndClaim(batchSize);
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    await resetEmbeddingNull(rows);
    // Re-set outcome=null on queue rows so this strategy can finalize them. (After
    // each writeback, the queue rows are 'completed'. To rerun we need them open.)
    const qIds = rows.map(r => String(r.queueId));
    await sql`update embedding_queue set outcome = null where id = any(${qIds}::bigint[])`;
    const ms = await fn(rows);
    times.push(ms);
  }
  times.sort((a, b) => a - b);
  console.log(`${label.padEnd(40)} batch=${String(batchSize).padStart(3)}  times=[${times.join(', ')}]ms  median=${times[1]}ms`);
}

async function main() {
  // RTT warm-up
  for (let i = 0; i < 3; i++) await sql`select 1`;
  const rtts: number[] = [];
  for (let i = 0; i < 5; i++) { const t = Date.now(); await sql`select 1`; rtts.push(Date.now() - t); }
  console.log(`RTT: ${rtts.join(', ')}ms (min=${Math.min(...rtts)})`);

  for (const size of [128, 512]) {
    console.log(`\n--- batch size ${size} ---`);
    await bench('A) text unnest, full precision',  size, rows => writeTextUnnest(rows, 'full'));
    await bench('B) text unnest, toFixed(5)',      size, rows => writeTextUnnest(rows, 'fixed5'));
    await bench('C) text unnest, toFixed(4)',      size, rows => writeTextUnnest(rows, 'fixed4'));
    await bench('D) binary COPY (txn + temp)',     size, rows => writeBinaryCopyTxn(rows));
    await bench('E) binary COPY (reserved conn)',  size, rows => writeBinaryCopyReserved(rows));
  }

  await sql.end();
}

await main();
