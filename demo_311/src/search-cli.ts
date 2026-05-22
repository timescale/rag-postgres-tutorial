// search-cli.ts — exercises all 7 search modes against the loaded NYC 311 dataset.
// Each section is independent; can be run after the worker has drained the queue.

import './env.js';
import { searchDocuments, searchSql as sql } from './search.js';

type Section = { title: string; run: () => Promise<unknown> };

const sections: Section[] = [
  // 1. BM25 (keyword)
  {
    title: '1. BM25 keyword search: "pothole brooklyn"',
    run: () => searchDocuments({ fulltext: 'pothole brooklyn', limit: 5 }),
  },

  // 2. Semantic (vector)
  {
    title: '2. Semantic search: "loud music keeping me up at night"',
    run: () => searchDocuments({ semantic: 'loud music keeping me up at night', limit: 5 }),
  },

  // 3. Hybrid (RRF)
  {
    title: '3. Hybrid: bm25 + semantic for "abandoned car on the street"',
    run: () => searchDocuments({
      fulltext: 'abandoned car on the street',
      semantic: 'abandoned car on the street',
      limit: 5,
    }),
  },

  // 4. Hierarchical (ltree) — restrict to Brooklyn DOT complaints
  {
    title: '4. Hierarchical: tree <@ nyc.brooklyn.dot.* (filter-only)',
    run: () => searchDocuments({ tree: 'nyc.brooklyn.dot', limit: 5 }),
  },

  // 5. Temporal (tstzrange) — last 24h
  {
    title: '5. Temporal: complaints from the most recent 24h in the dataset',
    run: async () => {
      const [{ max }] = await sql<[{ max: string }]>`select max(lower(temporal)) as max from documents`;
      const to = new Date(max);
      const from = new Date(to.getTime() - 24 * 3600 * 1000);
      return searchDocuments({
        temporal: { from: from.toISOString(), to: to.toISOString() },
        limit: 5,
      });
    },
  },

  // 6. Geospatial (PostGIS) — 1km radius around Times Square
  {
    title: '6. Geospatial: 1km around Times Square (40.7580, -73.9855)',
    run: () => searchDocuments({
      near: { lon: -73.9855, lat: 40.7580, radiusMeters: 1000 },
      limit: 5,
    }),
  },

  // 7. Metadata (JSONB) — Open status, NYPD agency
  {
    title: '7. Metadata: meta @> {"agency":"NYPD","status":"In Progress"}',
    run: () => searchDocuments({
      meta: { agency: 'NYPD', status: 'In Progress' },
      limit: 5,
    }),
  },

  // Composition bonus: hybrid + hierarchical + meta + near
  {
    title: '8. Composition: hybrid noise complaints in Manhattan within 5km of Times Square',
    run: () => searchDocuments({
      fulltext: 'noise complaint',
      semantic: 'noise complaint',
      tree: 'nyc.manhattan',
      near: { lon: -73.9855, lat: 40.7580, radiusMeters: 5000 },
      limit: 5,
    }),
  },
];

function summarize(rows: unknown): string {
  if (!Array.isArray(rows)) return JSON.stringify(rows);
  return rows
    .map((r: any) => `  [${r.score?.toFixed?.(4) ?? '-'}] ${r.tree} :: ${String(r.content).slice(0, 120)}`)
    .join('\n');
}

async function main() {
  const onlyArg = process.argv[2];
  const filtered = onlyArg ? sections.filter(s => s.title.startsWith(onlyArg)) : sections;
  for (const section of filtered) {
    console.log(`\n=== ${section.title} ===`);
    try {
      const rows = await section.run();
      const arr = Array.isArray(rows) ? rows : [rows];
      console.log(`got ${arr.length} rows`);
      console.log(summarize(rows));
    } catch (err) {
      console.error('ERROR:', err);
    }
  }
  await sql.end();
}

main().catch(e => { console.error(e); process.exit(1); });
