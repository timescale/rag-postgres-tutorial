// CLI driver for search.ts — runs the seven modes against the loaded 311 corpus
// to sanity-check that they all behave end-to-end.

import { sql } from './db.js';
import { searchDocuments, type SearchParams, type SearchResult } from './search.js';

function fmt(rows: SearchResult[]) {
  return rows.map((r, i) => {
    const meta = r.meta as { agency?: string; borough?: string; status?: string };
    const dist = r.meters !== undefined ? ` [${Math.round(r.meters)}m]` : '';
    return `  ${i + 1}. score=${r.score.toFixed(4)}${dist} ${meta.agency}/${meta.borough}/${meta.status}\n     ${r.content.slice(0, 140)}`;
  }).join('\n');
}

async function run(label: string, params: SearchParams) {
  const t0 = Date.now();
  const rows = await searchDocuments(params);
  const dt = Date.now() - t0;
  console.log(`\n=== ${label} (${rows.length} rows, ${dt}ms) ===`);
  console.log(fmt(rows));
}

async function main() {
  await run('6a BM25:   "loud music neighbor"', {
    fulltext: 'loud music neighbor',
    limit: 5,
  });

  await run('6b vector: "people partying late at night"', {
    semantic: 'people partying late at night',
    limit: 5,
  });

  await run('6c hybrid: same query, both modes', {
    fulltext: 'people partying late at night',
    semantic: 'people partying late at night',
    limit: 5,
  });

  await run('6d ltree:  nyc.brooklyn.nypd.*', {
    tree: 'nyc.brooklyn.nypd',
    limit: 5,
  });

  // Dataset is "latest 1000 311 requests at load time" — narrow the window to
  // the actual range. Adjust if you reload from Socrata.
  await run('6e temporal: one-hour window inside the loaded range', {
    temporal: { from: '2026-05-25T00:00:00Z', to: '2026-05-25T01:00:00Z' },
    limit: 5,
  });

  await run('6f geo:    within 500m of Times Square', {
    near: { lon: -73.9857, lat: 40.7589, radiusMeters: 500 },
    limit: 5,
  });

  await run('6g meta:   agency=HPD, status=Open', {
    meta: { agency: 'HPD', status: 'Open' },
    limit: 5,
  });

  await run('compose:  hybrid + meta(agency=NYPD) + brooklyn subtree', {
    fulltext: 'illegal parking',
    semantic: 'illegal parking',
    meta: { agency: 'NYPD' },
    tree: 'nyc.brooklyn',
    limit: 5,
  });

  await sql.end();
}

main().catch(async err => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
