// Exercises every search mode against the loaded NYC 311 corpus.
import 'dotenv/config';
import { searchDocuments, _sql } from './search.js';

function header(s: string) {
  console.log('\n' + '='.repeat(70));
  console.log(s);
  console.log('='.repeat(70));
}

function showHit(r: { content: string; tree: string; score: number; meters?: number }) {
  const short = r.content.replace(/\s+/g, ' ').slice(0, 110);
  const m = r.meters !== undefined ? ` @ ${Math.round(r.meters)}m` : '';
  console.log(`  [${r.score.toFixed(4)}${m}] ${r.tree}`);
  console.log(`    ${short}`);
}

async function main() {
  // 6a. BM25 — exact keyword. "pothole" should hit DOT street-condition reports.
  header('6a. BM25: "pothole"');
  let t = Date.now();
  let hits = await searchDocuments({ fulltext: 'pothole', limit: 5 });
  console.log(`(${Date.now() - t}ms, ${hits.length} hits)`);
  hits.forEach(showHit);

  // 6b. Vector — paraphrase. "loud music at night" should hit noise complaints.
  header('6b. Semantic: "loud music at night keeping me awake"');
  t = Date.now();
  hits = await searchDocuments({
    semantic: 'loud music at night keeping me awake',
    limit: 5,
  });
  console.log(`(${Date.now() - t}ms, ${hits.length} hits)`);
  hits.forEach(showHit);

  // 6c. Hybrid (BM25 + vector + RRF)
  header('6c. Hybrid: "rat sighting near restaurant"');
  t = Date.now();
  hits = await searchDocuments({
    fulltext: 'rat sighting near restaurant',
    semantic: 'rat sighting near restaurant',
    limit: 5,
  });
  console.log(`(${Date.now() - t}ms, ${hits.length} hits)`);
  hits.forEach(showHit);

  // 6d. ltree — Manhattan subtree only
  header('6d. ltree filter: nyc.manhattan.*');
  t = Date.now();
  hits = await searchDocuments({ tree: 'nyc.manhattan', limit: 5 });
  console.log(`(${Date.now() - t}ms, ${hits.length} hits)`);
  hits.forEach(showHit);

  // 6e. Temporal — anything whose [created, closed) overlaps the last 6 hours
  header('6e. Temporal: last 6 hours');
  const sixAgo = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const now = new Date().toISOString();
  t = Date.now();
  hits = await searchDocuments({
    temporal: { from: sixAgo, to: now },
    limit: 5,
  });
  console.log(`(${Date.now() - t}ms, ${hits.length} hits, window=${sixAgo} -> ${now})`);
  hits.forEach(showHit);

  // 6f. Geospatial — radius around Times Square (40.7580 N, -73.9855 E)
  header('6f. Geo: within 2km of Times Square');
  t = Date.now();
  hits = await searchDocuments({
    near: { lon: -73.9855, lat: 40.758, radiusMeters: 2000 },
    limit: 5,
  });
  console.log(`(${Date.now() - t}ms, ${hits.length} hits)`);
  hits.forEach(showHit);

  // 6g. JSONB — only NYPD agency rows
  header('6g. JSONB meta @> {"agency":"NYPD"}');
  t = Date.now();
  hits = await searchDocuments({ meta: { agency: 'NYPD' }, limit: 5 });
  console.log(`(${Date.now() - t}ms, ${hits.length} hits)`);
  hits.forEach(showHit);

  // Compose: hybrid + ltree + temporal + geo + meta
  header('Compose: hybrid "noise" + Brooklyn subtree + last 24h + 5km of City Hall + meta status=Open');
  t = Date.now();
  hits = await searchDocuments({
    fulltext: 'noise',
    semantic: 'loud noise complaint',
    tree: 'nyc.brooklyn',
    temporal: {
      from: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      to: new Date().toISOString(),
    },
    near: { lon: -74.0060, lat: 40.7128, radiusMeters: 5000 },
    meta: { status: 'Open' },
    limit: 5,
  });
  console.log(`(${Date.now() - t}ms, ${hits.length} hits)`);
  hits.forEach(showHit);

  await _sql.end();
}

await main();
