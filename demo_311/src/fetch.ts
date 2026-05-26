// Fetch a sample of NYC 311 Service Requests via Socrata API.
// One file per page so we can load in batches without re-downloading.
import 'dotenv/config';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const DATASET = 'erm2-nwe9'; // 311 Service Requests
const PAGE_SIZE = 1000;
const PAGES = Number(process.env.PAGES ?? 2);
const OUT_DIR = 'data';

const where = [
  'latitude IS NOT NULL',
  'longitude IS NOT NULL',
  'descriptor IS NOT NULL',
  'borough IS NOT NULL',
  'complaint_type IS NOT NULL',
  'agency IS NOT NULL',
].join(' AND ');

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (let i = 0; i < PAGES; i++) {
    const offset = i * PAGE_SIZE;
    const params = new URLSearchParams({
      $limit: String(PAGE_SIZE),
      $offset: String(offset),
      $where: where,
      $order: 'created_date DESC',
    });
    const url = `https://data.cityofnewyork.us/resource/${DATASET}.json?${params.toString()}`;
    process.stdout.write(`fetching page ${i + 1}/${PAGES}… `);
    const t0 = Date.now();
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`HTTP ${res.status}: ${await res.text()}`);
      process.exit(1);
    }
    const rows = (await res.json()) as unknown[];
    const path = join(OUT_DIR, `page-${String(i).padStart(3, '0')}.json`);
    await writeFile(path, JSON.stringify(rows));
    console.log(`${rows.length} rows -> ${path} (${Date.now() - t0}ms)`);
    if (rows.length < PAGE_SIZE) break;
  }
}

await main();
