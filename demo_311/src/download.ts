// Download a sample of NYC 311 service requests from the NYC Open Data Socrata API.
// Writes to data/nyc311.jsonl, one record per line.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LIMIT = Number(process.env.LIMIT ?? 500);
const ENDPOINT = 'https://data.cityofnewyork.us/resource/erm2-nwe9.json';

async function main() {
  const url = `${ENDPOINT}?$limit=${LIMIT}&$order=created_date DESC`;
  console.log(`Fetching ${LIMIT} rows from ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const rows: unknown[] = await res.json();
  console.log(`Got ${rows.length} rows`);

  const out = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  const outPath = path.resolve(__dirname, '..', 'data', 'nyc311.jsonl');
  await writeFile(outPath, out);
  console.log(`Wrote ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
