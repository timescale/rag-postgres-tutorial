// Compare full-precision vs trimmed-precision vector serialization.
import 'dotenv/config';
import { embed } from 'ai';
import { openai } from '@ai-sdk/openai';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
const model = openai.embeddingModel('text-embedding-3-small');

const N = 128;

async function main() {
  // Embed N realistic queries so we have realistic vectors
  console.log(`embedding ${N} sample texts...`);
  const sampleVecs: number[][] = [];
  while (sampleVecs.length < N) {
    const { embedding } = await embed({ model, value: `sample ${sampleVecs.length} text` });
    sampleVecs.push(embedding);
  }

  const fullPrec = sampleVecs.map(e => `[${e.join(',')}]`);
  const trim4 = sampleVecs.map(e => `[${e.map(x => x.toFixed(4)).join(',')}]`);
  const trim5 = sampleVecs.map(e => `[${e.map(x => x.toFixed(5)).join(',')}]`);

  const sizeOf = (arr: string[]) => arr.reduce((s, v) => s + v.length, 0);
  console.log(`payload sizes:`);
  console.log(`  full     ${(sizeOf(fullPrec) / 1024).toFixed(0)} KB`);
  console.log(`  toFixed5 ${(sizeOf(trim5) / 1024).toFixed(0)} KB`);
  console.log(`  toFixed4 ${(sizeOf(trim4) / 1024).toFixed(0)} KB`);

  // Warm
  for (let i = 0; i < 3; i++) await sql`select 1`;

  async function timeRoundTrip(label: string, vecs: string[]) {
    const t = Date.now();
    await sql`select count(*) from unnest(${vecs}::text[]) as t(v) where (t.v::halfvec) is not null`;
    console.log(`${label.padEnd(16)} ${Date.now() - t}ms`);
  }

  // Run each 3 times to get a stable read
  for (let i = 0; i < 3; i++) {
    console.log(`\n=== run ${i + 1} ===`);
    await timeRoundTrip('full precision', fullPrec);
    await timeRoundTrip('toFixed(5)', trim5);
    await timeRoundTrip('toFixed(4)', trim4);
  }

  await sql.end();
}

await main();
