// Load NYC 311 Service Requests into the `documents` table.
//
// Uses the unnest(typed[]...) pattern from the tutorial's Step 1 inset.
// Each column arrives at the server with its proper PG type. For `meta`,
// pre-stringify to string[] and cast ::text[]::jsonb[] in SQL — postgres@3's
// template tag rejects object arrays, and its array serializer sniffs each
// element for a .type field (Parameter-unwrap convention), so passing raw
// objects crashes the load on any meta with a top-level `type` key.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sql } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(here, '..', 'data', 'nyc311_1000.json');

interface Row {
  unique_key: string;
  created_date: string;
  closed_date?: string;
  agency: string;
  agency_name?: string;
  complaint_type: string;
  descriptor: string;
  incident_address?: string;
  incident_zip?: string;
  borough?: string;
  city?: string;
  status?: string;
  resolution_description?: string;
  open_data_channel_type?: string;
  council_district?: string;
  latitude?: string;
  longitude?: string;
}

function slug(s: string | undefined | null): string {
  if (!s) return 'unknown';
  const v = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return v.length > 0 ? v.slice(0, 256) : 'unknown';
}

function buildContent(r: Row): string {
  const parts = [
    `${r.complaint_type}: ${r.descriptor}.`,
    r.incident_address ? `Address: ${r.incident_address}, ${r.borough ?? ''} ${r.incident_zip ?? ''}.` : '',
    r.status ? `Status: ${r.status}.` : '',
    r.resolution_description ?? '',
  ];
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

// tstzrange literal as a string: `[start,end)` for open intervals, `[t,t]` for
// point-in-time. We pre-build the literal in JS so we can pass a flat text[]
// to the driver — array-of-range types travel safely through ::tstzrange[]
// only after this kind of pre-encoding.
function buildTemporal(created: string, closed: string | null): string {
  if (closed === null) return `[${created},${created}]`;
  if (new Date(closed) <= new Date(created)) return `[${created},${created}]`;
  return `[${created},${closed})`;
}

interface Cols {
  contents:  string[];
  metas:     Record<string, unknown>[];
  trees:     string[];
  temporals: string[];
  lons:      (number | null)[];
  lats:      (number | null)[];
}

function rowToCols(r: Row, c: Cols, seen: Set<string>): void {
  if (!r.complaint_type || !r.descriptor) return;
  if (seen.has(r.unique_key)) return;
  seen.add(r.unique_key);

  const lon = r.longitude ? Number(r.longitude) : null;
  const lat = r.latitude ? Number(r.latitude) : null;

  c.contents.push(buildContent(r));
  c.metas.push({
    unique_key: r.unique_key,
    agency: r.agency,
    agency_name: r.agency_name,
    borough: r.borough,
    city: r.city,
    status: r.status,
    complaint_type: r.complaint_type,
    descriptor: r.descriptor,
    channel: r.open_data_channel_type,
    council_district: r.council_district,
    zip: r.incident_zip,
  });
  c.trees.push(['nyc', slug(r.borough), slug(r.agency), slug(r.complaint_type)].join('.'));
  c.temporals.push(buildTemporal(r.created_date, r.closed_date ?? null));
  c.lons.push(Number.isFinite(lon as number) ? lon : null);
  c.lats.push(Number.isFinite(lat as number) ? lat : null);
}

async function main() {
  const raw = JSON.parse(await readFile(DATA_PATH, 'utf8')) as Row[];
  console.log(`read ${raw.length} input rows from ${DATA_PATH}`);

  const seen = new Set<string>();
  const all: Cols = { contents: [], metas: [], trees: [], temporals: [], lons: [], lats: [] };
  for (const r of raw) rowToCols(r, all, seen);
  const n = all.contents.length;
  console.log(`${n} rows after slug + dedupe`);

  const t0 = Date.now();
  const BATCH = 200;
  let inserted = 0;

  for (let i = 0; i < n; i += BATCH) {
    const end = Math.min(i + BATCH, n);
    const contents  = all.contents.slice(i, end);
    const metas     = all.metas.slice(i, end);
    const trees     = all.trees.slice(i, end);
    const temporals = all.temporals.slice(i, end);
    const lons      = all.lons.slice(i, end);
    const lats      = all.lats.slice(i, end);

    const result = await sql`
      insert into documents (content, meta, tree, temporal, geom)
      select
        content,
        meta,
        tree,
        temporal,
        case when lon is null or lat is null then null
             else ST_SetSRID(ST_MakePoint(lon, lat), 4326)
        end as geom
      from unnest(
        ${contents}::text[],
        ${metas.map(m => JSON.stringify(m))}::text[]::jsonb[],
        ${trees}::ltree[],
        ${temporals}::tstzrange[],
        ${lons}::float8[],
        ${lats}::float8[]
      ) as t(content, meta, tree, temporal, lon, lat)
      on conflict do nothing
      returning id
    `;
    inserted += result.length;
    process.stdout.write(`\rinserted ${inserted} / ${n}`);
  }
  const dt = (Date.now() - t0) / 1000;
  console.log(`\nfinished: inserted ${inserted} rows in ${dt.toFixed(2)}s (${(inserted / dt).toFixed(1)} rows/s)`);

  const [{ count: docs }]   = await sql<{ count: string }[]>`select count(*) as count from documents`;
  const [{ count: queued }] = await sql<{ count: string }[]>`
    select count(*) as count from embedding_queue where outcome is null
  `;
  console.log(`documents in table: ${docs}`);
  console.log(`embedding_queue (open): ${queued}`);

  await sql.end();
}

main().catch(async err => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
