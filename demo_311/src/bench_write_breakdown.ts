// Break down the write phase: shipping payload vs. actually updating rows.
import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });

const N = 128;
const DIM = 1536;

function fakeVec(): string {
  // Match the worker's serialization: [f,f,f,...]
  const arr = new Array<number>(DIM);
  for (let i = 0; i < DIM; i++) arr[i] = (Math.random() - 0.5);
  return `[${arr.join(',')}]`;
}

async function warm() {
  for (let i = 0; i < 3; i++) await sql`select 1`;
}

async function timeIt(label: string, fn: () => Promise<unknown>) {
  const t = Date.now();
  await fn();
  const ms = Date.now() - t;
  console.log(`${label.padEnd(58)} ${ms}ms`);
  return ms;
}

async function main() {
  await warm();

  // Build a payload like the real worker would send
  const vecs = Array.from({ length: N }, fakeVec);
  const ids = await sql<{ id: string; embedding_version: number }[]>`
    select id, embedding_version from documents limit ${N}
  `;
  const docIds = ids.map(r => r.id);
  const versions = ids.map(r => r.embedding_version);

  console.log(`payload: ${N} vecs * ${DIM} dims = ~${(vecs.reduce((s, v) => s + v.length, 0) / 1024).toFixed(0)} KB text\n`);

  // 1) Pure RTT (no payload)
  await timeIt('1) select 1                                ', () => sql`select 1`);

  // 2) Send payload, server parses but does nothing (no read, no write)
  await timeIt('2) send vecs, server parses, no row touched', () => sql`
    select count(*) from unnest(${vecs}::text[]) as t(v)
    where length(t.v) > 0
  `);

  // 3) Send payload, server parses each as halfvec, no row touched
  await timeIt('3) send vecs, cast to halfvec, no row write', () => sql`
    select count(*) from unnest(${vecs}::text[]) as t(v)
    where (t.v::halfvec) is not null
  `);

  // 4) Send payload + UPDATE documents.embedding only (no queue update)
  await timeIt('4) UPDATE documents only (no queue write)  ', () => sql`
    with input as (
      select * from unnest(${docIds}::uuid[], ${versions}::int[], ${vecs}::text[]) as t(doc_id, ver, vec)
    )
    update documents d
       set embedding = i.vec::halfvec
      from input i
     where d.id = i.doc_id and d.embedding_version = i.ver
  `);

  // 5) Full real-worker writeback (UPDATE docs + UPDATE queue)
  // Find some open queue ids to exercise the queue path
  const queueRows = await sql<{ id: string }[]>`
    select id from embedding_queue where outcome is null limit ${N}
  `;
  if (queueRows.length === N) {
    const qIds = queueRows.map(r => r.id);
    await timeIt('5) full writeback (docs + queue)           ', () => sql`
      with input as (
        select * from unnest(
          ${docIds}::uuid[], ${versions}::int[], ${qIds}::bigint[], ${vecs}::text[]
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
    `);
  } else {
    console.log(`(5 skipped: only ${queueRows.length} open queue rows; need ${N})`);
  }

  await sql.end();
}

await main();
