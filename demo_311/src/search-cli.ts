// Exercises all seven search modes against the 311 corpus and prints a
// brief summary for each. Run with `npm run search`.
import { searchDocuments, sql } from './search.js';

function header(title: string) {
  console.log('\n' + '='.repeat(72));
  console.log(title);
  console.log('='.repeat(72));
}

function summarize(results: { id: string; content: string; tree: string; score: number; meters?: number; meta: Record<string, unknown> }[]) {
  if (results.length === 0) {
    console.log('  (no results)');
    return;
  }
  for (const r of results.slice(0, 5)) {
    const m = r.meters !== undefined ? ` meters=${r.meters.toFixed(0)}` : '';
    const status = (r.meta as any).status ?? '?';
    console.log(`  score=${r.score.toFixed(4)}${m} [${status}] ${r.tree}`);
    console.log(`    ${r.content.slice(0, 100).replace(/\s+/g, ' ')}...`);
  }
  if (results.length > 5) console.log(`  ... and ${results.length - 5} more`);
}

// --- 1. BM25 ---
header('1. BM25 (fulltext): "pothole street"');
summarize(await searchDocuments({ fulltext: 'pothole street', limit: 5 }));

// --- 2. Vector ---
header('2. Semantic (vector): "people making too much noise late at night"');
summarize(await searchDocuments({ semantic: 'people making too much noise late at night', limit: 5 }));

// --- 3. Hybrid ---
header('3. Hybrid (RRF): "loud music party"');
summarize(await searchDocuments({
  fulltext: 'loud music party',
  semantic: 'loud music party',
  limit: 5,
}));

// --- 4. Tree (ltree) ---
header('4. Tree filter: nyc.brooklyn.*');
summarize(await searchDocuments({ tree: 'nyc.brooklyn', limit: 5 }));

// --- 5. Temporal ---
// Pick a window from the data (last 24h before max created date).
const { maxCreated } = (await sql<{ maxCreated: string }[]>`select max(lower(temporal))::text as "maxCreated" from documents`)[0];
const fromTs = new Date(new Date(maxCreated).getTime() - 24 * 3600 * 1000).toISOString();
header(`5. Temporal: complaints overlapping [${fromTs}, ${maxCreated})`);
summarize(await searchDocuments({
  temporal: { from: fromTs, to: maxCreated },
  limit: 5,
}));

// --- 6. Geospatial ---
// Times Square: 40.7580, -73.9855
header('6. Geo: 1km radius of Times Square (40.7580, -73.9855)');
summarize(await searchDocuments({
  near: { lat: 40.7580, lon: -73.9855, radiusMeters: 1000 },
  limit: 5,
}));

// --- 7. Metadata (JSONB) ---
header('7. Meta containment: { "agency": "DOT" }');
summarize(await searchDocuments({ meta: { agency: 'DOT' }, limit: 5 }));

// --- Composition: hybrid + tree + meta + temporal + near ---
header('Composition: hybrid("pothole") + nyc.brooklyn + DOT + last 14d + 5km of Times Square');
const fortnightAgo = new Date(new Date(maxCreated).getTime() - 14 * 24 * 3600 * 1000).toISOString();
summarize(await searchDocuments({
  fulltext: 'pothole',
  semantic: 'broken road surface',
  tree: 'nyc.brooklyn',
  meta: { agency: 'DOT' },
  temporal: { from: fortnightAgo, to: maxCreated },
  near: { lat: 40.7580, lon: -73.9855, radiusMeters: 5000 },
  limit: 5,
}));

// --- Filter-only with geo sort ---
header('Filter-only with geo sort: 200m of Times Square');
summarize(await searchDocuments({
  near: { lat: 40.7580, lon: -73.9855, radiusMeters: 200 },
  limit: 5,
}));

// --- Hybrid composed with a geo filter (text/vector sorts, ST_DWithin filters) ---
header('Hybrid + geo filter: "noise" near Times Square (1km)');
summarize(await searchDocuments({
  fulltext: 'noise',
  semantic: 'loud noise complaint',
  near: { lat: 40.7580, lon: -73.9855, radiusMeters: 1000 },
  limit: 5,
}));

await sql.end();
console.log('\nDone.');
