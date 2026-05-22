// Quick CLI for exercising searchDocuments. Used by tests/manual probes.
//
//   npx tsx src/search-cli.ts '{"fulltext":"pothole","limit":5}'

import 'dotenv/config';
import { searchDocuments, sql } from './search.ts';

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: search-cli.ts <json-params>');
    process.exit(2);
  }
  const params = JSON.parse(arg);
  const t0 = Date.now();
  const rows = await searchDocuments(params);
  const dt = Date.now() - t0;
  console.log(`${rows.length} results in ${dt}ms`);
  for (const r of rows) {
    const first = r.content.split('\n')[0];
    console.log(`  ${r.score.toFixed(4)}  ${r.tree}  ${first}`);
  }
  await sql.end();
}

main().catch(async err => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
