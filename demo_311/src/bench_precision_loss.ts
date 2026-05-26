// Is toFixed(4) actually lossless relative to halfvec storage?
//   - halfvec stores IEEE 754 binary16: ~10 bits mantissa, *relative* precision ~1e-3
//   - toFixed(4) is *fixed-point*: absolute precision 5e-5 regardless of magnitude
// For values close to zero, toFixed(4) is COARSER than halfvec — so it can lose
// information that halfvec would have kept.
//
// This script:
//   1. Pulls real embeddings from the loaded corpus (already halfvec-stored).
//   2. Looks at the value distribution to see how often "near-zero" components occur.
//   3. Measures cosine similarity between the *full-precision JSON* vector and
//      the *toFixed(4)* version, after both are round-tripped through halfvec.
//      If the cosine is 1.0 to many 9's, toFixed(4) is "effectively lossless"
//      for retrieval. If it drifts, we have a real recall risk.
import 'dotenv/config';
import { embed } from 'ai';
import { openai } from '@ai-sdk/openai';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
const model = openai.embeddingModel('text-embedding-3-small');

function cosine(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function castViaHalfvec(vec: number[], fmt: 'full' | 'fixed4' | 'fixed5'): Promise<number[]> {
  const lit =
    fmt === 'full'   ? `[${vec.join(',')}]` :
    fmt === 'fixed4' ? `[${vec.map(x => x.toFixed(4)).join(',')}]` :
                       `[${vec.map(x => x.toFixed(5)).join(',')}]`;
  // Round-trip through halfvec so we measure precision-loss INCLUSIVE of halfvec storage.
  const [row] = await sql<{ v: string }[]>`
    select (${lit}::halfvec)::text as v
  `;
  return row.v.slice(1, -1).split(',').map(Number);
}

async function main() {
  // 1. Get N real embeddings — embed fresh queries so we have full-precision floats
  const queries = [
    'pothole on main street',
    'loud music keeping me awake',
    'rat sighting near restaurant',
    'noise complaint construction',
    'illegal parking blocking fire hydrant',
    'water leak in apartment building',
    'tree down after storm',
    'graffiti on subway',
    'broken street sign',
    'overflowing trash can',
  ];
  console.log(`embedding ${queries.length} queries...`);
  const vecs: number[][] = [];
  for (const q of queries) {
    const { embedding } = await embed({ model, value: q });
    vecs.push(embedding);
  }

  // 2. Distribution of |component| across all vectors
  const all = vecs.flat().map(Math.abs).sort((a, b) => a - b);
  const pct = (p: number) => all[Math.floor(all.length * p)];
  console.log(`\nComponent |x| distribution (across ${all.length} values):`);
  console.log(`  p01=${pct(0.01).toExponential(2)}  p10=${pct(0.10).toExponential(2)}  ` +
              `p50=${pct(0.50).toExponential(2)}  p90=${pct(0.90).toExponential(2)}  ` +
              `p99=${pct(0.99).toExponential(2)}  max=${all[all.length - 1].toExponential(2)}`);
  const belowFixed4Half = all.filter(x => x < 5e-5).length;
  const belowFixed5Half = all.filter(x => x < 5e-6).length;
  console.log(`  components below toFixed(4) half-step (5e-5): ${belowFixed4Half} (${(100*belowFixed4Half/all.length).toFixed(1)}%)`);
  console.log(`  components below toFixed(5) half-step (5e-6): ${belowFixed5Half} (${(100*belowFixed5Half/all.length).toFixed(1)}%)`);

  // 3. Cosine between full→halfvec and fixed4→halfvec
  console.log(`\nCosine self-similarity after each precision round-trip:`);
  console.log(`(full→halfvec) vs (X→halfvec):`);
  for (let i = 0; i < vecs.length; i++) {
    const full = await castViaHalfvec(vecs[i], 'full');
    const fx5 = await castViaHalfvec(vecs[i], 'fixed5');
    const fx4 = await castViaHalfvec(vecs[i], 'fixed4');
    const cos5 = cosine(full, fx5);
    const cos4 = cosine(full, fx4);
    const linf5 = Math.max(...full.map((x, k) => Math.abs(x - fx5[k])));
    const linf4 = Math.max(...full.map((x, k) => Math.abs(x - fx4[k])));
    console.log(
      `  q${i}: cos(full,fixed5)=${cos5.toFixed(8)}  cos(full,fixed4)=${cos4.toFixed(8)}  ` +
      `Linf5=${linf5.toExponential(2)}  Linf4=${linf4.toExponential(2)}`
    );
  }

  // 4. Cross-vector ranking check: does the order of cosine(q0, v_i) change
  //    when we re-embed q0 via fixed4 + halfvec?
  const q0 = vecs[0];
  const q0_full  = await castViaHalfvec(q0, 'full');
  const q0_fx4   = await castViaHalfvec(q0, 'fixed4');
  const others   = await Promise.all(vecs.slice(1).map(v => castViaHalfvec(v, 'full')));
  const rankFull = others.map((v, i) => ({ i, c: cosine(q0_full, v) })).sort((a, b) => b.c - a.c);
  const rankFx4  = others.map((v, i) => ({ i, c: cosine(q0_fx4,  v) })).sort((a, b) => b.c - a.c);
  console.log(`\nTop-9 cosine ranks against q0:`);
  console.log(`  full→halfvec : ${rankFull.map(r => `${r.i}(${r.c.toFixed(4)})`).join(' ')}`);
  console.log(`  fixed4→halfvec: ${rankFx4.map(r => `${r.i}(${r.c.toFixed(4)})`).join(' ')}`);
  const rankChanged = rankFull.some((r, i) => r.i !== rankFx4[i].i);
  console.log(`  ranking changed: ${rankChanged}`);

  await sql.end();
}

await main();
