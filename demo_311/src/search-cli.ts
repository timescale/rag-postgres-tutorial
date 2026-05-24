import { searchDocuments, sql, SearchParams } from './search.js';

// Quick CLI smoke tests against each search mode.
async function run() {
  const cases: Array<{ name: string; params: SearchParams }> = [
    {
      name: '1. BM25 only — "pothole"',
      params: { fulltext: 'pothole', limit: 3 },
    },
    {
      name: '2. Semantic only — "loud music at night"',
      params: { semantic: 'loud music at night', limit: 3 },
    },
    {
      name: '3. Hybrid — "noise complaint apartment"',
      params: { semantic: 'noise complaint apartment', fulltext: 'noise', limit: 3 },
    },
    {
      name: '4. Tree filter — all Brooklyn complaints (filter-only, ordered by recency)',
      params: { tree: 'nyc.brooklyn', limit: 3 },
    },
    {
      name: '5. Tree + BM25 — "noise" under nyc.brooklyn',
      params: { fulltext: 'noise', tree: 'nyc.brooklyn', limit: 3 },
    },
    {
      name: '6. Meta filter — DSNY agency',
      params: { meta: { agency: 'DSNY' }, limit: 3 },
    },
    {
      name: '7. Temporal — last 72 hours',
      params: {
        temporal: { from: new Date(Date.now() - 72 * 3600 * 1000).toISOString() },
        limit: 3,
      },
    },
    {
      name: '8. Geospatial filter-only — within 1km of Times Square (40.758, -73.985)',
      params: { near: { lon: -73.985, lat: 40.758, radiusMeters: 1000 }, limit: 3 },
    },
    {
      name: '9. Hybrid + geo + meta — "noise" near Times Square, DEP agency',
      params: {
        semantic: 'noise',
        fulltext: 'noise',
        near: { lon: -73.985, lat: 40.758, radiusMeters: 5000 },
        meta: { agency: 'DEP' },
        limit: 3,
      },
    },
  ];

  for (const c of cases) {
    console.log(`\n=== ${c.name} ===`);
    const t0 = Date.now();
    try {
      const res = await searchDocuments(c.params);
      const dt = Date.now() - t0;
      console.log(`  ${res.length} hits in ${dt}ms`);
      for (const r of res) {
        const summary = r.content.split('\n')[0].slice(0, 100);
        const dist = r.meters !== undefined ? ` (${Math.round(r.meters)}m)` : '';
        console.log(`    [${r.score.toFixed(3)}]${dist} ${r.tree} | ${summary}`);
      }
    } catch (err) {
      console.error(`  FAILED:`, err instanceof Error ? err.message : err);
    }
  }

  await sql.end();
}

run().catch(err => { console.error(err); process.exit(1); });
