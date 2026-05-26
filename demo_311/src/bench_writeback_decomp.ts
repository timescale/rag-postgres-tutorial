// Decompose the full-precision text writeback at the current RTT.
// Run each variant multiple times so TCP slow-start doesn't skew the read.
import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });

const N = 128, DIM = 1536;

function fakeVec(): string {
  const a = new Array<number>(DIM);
  for (let i = 0; i < DIM; i++) a[i] = (Math.random() - 0.5) * 0.05;
  return `[${a.join(',')}]`;
}

async function rep(label: string, fn: () => Promise<unknown>, iters = 5) {
  const ts: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t = Date.now();
    await fn();
    ts.push(Date.now() - t);
  }
  ts.sort((a, b) => a - b);
  console.log(`${label.padEnd(50)} runs=[${ts.join(', ')}]ms  median=${ts[2]}ms`);
}

async function main() {
  // Warm
  for (let i = 0; i < 5; i++) await sql`select 1`;

  const vecs = Array.from({ length: N }, fakeVec);
  console.log(`payload: ${(vecs.reduce((s, v) => s + v.length, 0) / 1024).toFixed(0)} KB text`);

  // Identify some docs we can UPDATE without changing embedding_version (cheap UPDATE)
  const ids = await sql<{ id: string; embedding_version: number }[]>`
    select id, embedding_version from documents limit ${N}
  `;
  const docIds = ids.map(r => r.id);
  const vers = ids.map(r => r.embedding_version);

  await rep('A) pure RTT (select 1)', async () => sql`select 1`);

  await rep('B) ship payload, count only', async () => sql`
    select count(*) from unnest(${vecs}::text[]) as t(v) where length(t.v) > 0
  `);

  await rep('C) ship payload, cast each to halfvec', async () => sql`
    select count(*) from unnest(${vecs}::text[]) as t(v) where (t.v::halfvec) is not null
  `);

  await rep('D) ship + UPDATE documents only', async () => sql`
    with input as (
      select * from unnest(${docIds}::uuid[], ${vers}::int[], ${vecs}::text[]) as t(doc_id, ver, vec)
    )
    update documents d
       set embedding = i.vec::halfvec
      from input i
     where d.id = i.doc_id and d.embedding_version = i.ver
  `);

  await sql.end();
}

await main();
