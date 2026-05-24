// Reads data/raw.jsonl and bulk-inserts into the documents table.
// Embedding is left NULL; the worker will fill it in.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

type Row = {
  unique_key: string;
  created_date: string;
  closed_date?: string;
  agency?: string;
  agency_name?: string;
  complaint_type?: string;
  descriptor?: string;
  status?: string;
  resolution_description?: string;
  incident_zip?: string;
  incident_address?: string;
  street_name?: string;
  city?: string;
  borough?: string;
  location_type?: string;
  latitude?: string;
  longitude?: string;
};

// ltree labels: [A-Za-z0-9_], max 256 chars. Anything else gets normalized.
function ltreeLabel(s: string | undefined, fallback: string): string {
  if (!s) return fallback;
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 256);
  return cleaned || fallback;
}

function buildContent(r: Row): string {
  const parts: string[] = [];
  if (r.complaint_type) parts.push(r.complaint_type);
  if (r.descriptor) parts.push(`- ${r.descriptor}`);
  parts.push('.');
  if (r.agency_name) parts.push(`Agency: ${r.agency_name}.`);
  if (r.status) parts.push(`Status: ${r.status}.`);
  if (r.incident_address) parts.push(`Address: ${r.incident_address}, ${r.borough ?? ''} ${r.incident_zip ?? ''}.`.trim());
  else if (r.borough) parts.push(`Borough: ${r.borough}.`);
  if (r.location_type) parts.push(`Location type: ${r.location_type}.`);
  if (r.resolution_description) parts.push(r.resolution_description);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

const raw = readFileSync(resolve(process.cwd(), 'data/raw.jsonl'), 'utf8');
const rows: Row[] = raw
  .split('\n')
  .filter(l => l.trim().length > 0)
  .map(l => JSON.parse(l) as Row);

console.log(`parsed ${rows.length} rows`);

// Bulk insert in batches.
const BATCH = 500;
let inserted = 0;
const t0 = performance.now();

for (let i = 0; i < rows.length; i += BATCH) {
  const slice = rows.slice(i, i + BATCH);

  const values = slice.map(r => {
    const borough = ltreeLabel(r.borough, 'unknown');
    const agency  = ltreeLabel(r.agency, 'unknown');
    const ctype   = ltreeLabel(r.complaint_type, 'unknown');
    const tree    = `nyc.${borough}.${agency}.${ctype}`;

    const created = r.created_date;
    const closed  = r.closed_date;
    // Convention from tutorial: [start,end) when closed, [start,'infinity') when open,
    // [t,t] for an instantaneous event (not used here).
    const temporal = closed && closed > created
      ? `[${created},${closed})`
      : `[${created},infinity)`;

    const lon = r.longitude ? parseFloat(r.longitude) : null;
    const lat = r.latitude  ? parseFloat(r.latitude)  : null;

    const meta = {
      unique_key: r.unique_key,
      agency: r.agency,
      agency_name: r.agency_name,
      complaint_type: r.complaint_type,
      descriptor: r.descriptor,
      status: r.status,
      borough: r.borough,
      city: r.city,
      incident_zip: r.incident_zip,
      incident_address: r.incident_address,
      location_type: r.location_type,
      is_closed: !!closed,
    };

    return {
      content: buildContent(r),
      meta,
      tree,
      temporal,
      lon,
      lat,
    };
  });

  // Bulk insert: pass the batch as one jsonb array and unfold server-side.
  // This avoids the `text[]::jsonb[]` trap that stores each element as a JSON
  // string scalar instead of an object (the constraint jsonb_typeof = 'object'
  // catches it, but the silent failure mode is data loss).
  await sql`
    insert into documents (content, meta, tree, temporal, geom)
    select
      j->>'content',
      j->'meta',
      (j->>'tree')::ltree,
      (j->>'temporal')::tstzrange,
      case when j->'lon' is not null and j->'lat' is not null
           then ST_SetSRID(ST_MakePoint((j->>'lon')::float8, (j->>'lat')::float8), 4326)
           else null end
    from jsonb_array_elements(${sql.json(values)}::jsonb) as j
  `;

  inserted += slice.length;
  console.log(`inserted ${inserted}/${rows.length}`);
}

console.log(`done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
await sql.end();
