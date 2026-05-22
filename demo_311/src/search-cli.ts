// Smoke-tests every search mode against the loaded NYC 311 corpus.
//   tsx src/search-cli.ts                          # runs all modes
//   tsx src/search-cli.ts bm25 "noise"            # single mode
import { searchDocuments, sql } from './search.js';

type Test = { name: string; run: () => Promise<unknown> };

function preview(r: { id: string; content: string; score: number; tree: string }) {
  const trimmed = r.content.length > 120 ? r.content.slice(0, 117) + '...' : r.content;
  return `  [${r.score.toFixed(3)}] ${r.tree}  —  ${trimmed}`;
}

function show(name: string, rows: { id: string; content: string; score: number; tree: string }[]) {
  console.log(`\n=== ${name} (${rows.length} results) ===`);
  for (const r of rows.slice(0, 5)) console.log(preview(r));
}

const tests: Test[] = [
  {
    name: '6a. BM25 (keyword)',
    run: async () => {
      const rows = await searchDocuments({ fulltext: 'noise loud music', limit: 5 });
      show('BM25', rows);
    },
  },
  {
    name: '6b. Semantic (vector)',
    run: async () => {
      const rows = await searchDocuments({ semantic: 'loud party disturbing neighbors at night', limit: 5 });
      show('Semantic', rows);
    },
  },
  {
    name: '6c. Hybrid (RRF)',
    run: async () => {
      const rows = await searchDocuments({
        fulltext: 'illegal parking',
        semantic: 'car blocking the driveway',
        limit: 5,
      });
      show('Hybrid', rows);
    },
  },
  {
    name: '6d. Hierarchical (ltree subtree)',
    run: async () => {
      const rows = await searchDocuments({ tree: 'nyc.manhattan', limit: 5 });
      show('Tree subtree', rows);
    },
  },
  {
    name: '6e. Temporal (range overlap)',
    run: async () => {
      const now = new Date();
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const rows = await searchDocuments({
        temporal: { from: monthAgo.toISOString(), to: now.toISOString() },
        limit: 5,
      });
      show('Temporal', rows);
    },
  },
  {
    name: '6f. Geospatial (radius around Times Square)',
    run: async () => {
      const rows = await searchDocuments({
        near: { lon: -73.9857, lat: 40.7580, radiusMeters: 1000 },
        limit: 5,
      });
      show('Geospatial', rows);
    },
  },
  {
    name: '6g. Metadata (JSONB containment)',
    run: async () => {
      const rows = await searchDocuments({ meta: { agency: 'NYPD' }, limit: 5 });
      show('Metadata', rows);
    },
  },
  {
    name: 'Composed: hybrid + tree + meta + near',
    run: async () => {
      const rows = await searchDocuments({
        fulltext: 'noise',
        semantic: 'loud party',
        tree: 'nyc.manhattan',
        meta: { agency: 'NYPD' },
        near: { lon: -73.9857, lat: 40.7580, radiusMeters: 5000 },
        limit: 5,
      });
      show('Composed', rows);
    },
  },
];

async function main() {
  const arg = process.argv[2];
  const filtered = arg ? tests.filter(t => t.name.toLowerCase().includes(arg.toLowerCase())) : tests;
  for (const t of filtered) {
    console.log(`\n--- ${t.name} ---`);
    try {
      await t.run();
    } catch (err) {
      console.error(`FAILED: ${t.name}`);
      console.error(err);
    }
  }
  await sql.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
