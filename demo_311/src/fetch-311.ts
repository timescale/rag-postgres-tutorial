// Pulls a sample of NYC 311 Service Requests from the Socrata API and saves
// to data/raw.jsonl. We filter for rows with lat/lon present so the geo column
// has signal, and span a few weeks so the temporal range has signal too.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ENDPOINT = 'https://data.cityofnewyork.us/resource/erm2-nwe9.json';
const TARGET = 2000;
const PAGE = 1000;

const OUT = resolve(process.cwd(), 'data/raw.jsonl');
mkdirSync(dirname(OUT), { recursive: true });

const where = "latitude IS NOT NULL AND longitude IS NOT NULL AND complaint_type IS NOT NULL AND descriptor IS NOT NULL";
const order = "created_date DESC";

const all: unknown[] = [];
let offset = 0;
while (all.length < TARGET) {
  const url = `${ENDPOINT}?$where=${encodeURIComponent(where)}&$order=${encodeURIComponent(order)}&$limit=${PAGE}&$offset=${offset}`;
  process.stdout.write(`fetching offset=${offset}... `);
  const t0 = performance.now();
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Socrata ${r.status}: ${await r.text()}`);
  const rows = await r.json() as unknown[];
  console.log(`${rows.length} rows in ${(performance.now() - t0).toFixed(0)}ms`);
  if (rows.length === 0) break;
  all.push(...rows);
  offset += rows.length;
  if (rows.length < PAGE) break;
}

const truncated = all.slice(0, TARGET);
const text = truncated.map(r => JSON.stringify(r)).join('\n') + '\n';
writeFileSync(OUT, text);
console.log(`wrote ${truncated.length} rows -> ${OUT}`);
