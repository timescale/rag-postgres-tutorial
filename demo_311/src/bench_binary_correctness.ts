// Sanity-check: a halfvec written via binary COPY should be bit-identical to
// the same halfvec written via text. Read both back and compare.
import 'dotenv/config';
import { embed } from 'ai';
import { openai } from '@ai-sdk/openai';
import postgres from 'postgres';
import { encodeBatchBinaryCopy } from './halfvec_binary.js';

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
const model = openai.embeddingModel('text-embedding-3-small');

async function main() {
  const { embedding } = await embed({ model, value: 'sanity check for halfvec binary copy' });
  const dim = embedding.length;

  // Create a scratch table, write same value via text and via binary, read back.
  await sql`drop table if exists _hv_check`;
  await sql`create table _hv_check (kind text primary key, v halfvec(${sql.unsafe(String(dim))}))`;

  // Text path
  const lit = `[${embedding.join(',')}]`;
  await sql`insert into _hv_check (kind, v) values ('text', ${lit}::halfvec)`;

  // Binary COPY path
  const buf = encodeBatchBinaryCopy(
    [{ queueId: 1n, docId: '00000000-0000-7000-8000-000000000001', version: 1, embedding }],
    dim
  );
  // The binary encoder writes (q_id bigint, doc_id uuid, ver int, vec halfvec).
  // Make a matching temp + insert just the halfvec back into _hv_check.
  await sql.begin(async tx => {
    await tx`create temp table _hv_in (q_id bigint, doc_id uuid, ver int, v halfvec(${tx.unsafe(String(dim))})) on commit drop`;
    const w = await tx`copy _hv_in from stdin with (format binary)`.writable();
    await new Promise<void>((resolve, reject) => {
      w.on('error', reject);
      w.on('finish', () => resolve());
      w.end(buf);
    });
    await tx`insert into _hv_check (kind, v) select 'binary', v from _hv_in`;
  });

  const rows = await sql<{ kind: string; v: string }[]>`
    select kind, v::text as v from _hv_check order by kind
  `;
  const text = rows.find(r => r.kind === 'text')!.v;
  const bin  = rows.find(r => r.kind === 'binary')!.v;
  const identical = text === bin;
  console.log(`text and binary stored values identical at the text level? ${identical}`);
  if (!identical) {
    // Compare as floats
    const a = text.slice(1, -1).split(',').map(Number);
    const b = bin.slice(1, -1).split(',').map(Number);
    let max = 0, ndiff = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (d > 0) { ndiff++; max = Math.max(max, d); }
    }
    console.log(`  diff: ${ndiff}/${a.length} components, max=${max.toExponential(3)}`);
  }

  // Cleanup
  await sql`drop table _hv_check`;
  await sql.end();
}

await main();
