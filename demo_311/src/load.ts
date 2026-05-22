// Fetch NYC 311 service requests from the public SODA endpoint and load into
// `documents`. Embeddings are filled in asynchronously by the worker.
//
// SODA reference: https://dev.socrata.com/foundry/data.cityofnewyork.us/erm2-nwe9
import postgres from 'postgres';
import { DATABASE_URL } from './env.js';

const sql = postgres(DATABASE_URL);

// How many service requests to load on each run.
const LIMIT = Number(process.env.LIMIT ?? 500);

interface Row311 {
  unique_key: string;
  created_date?: string;
  closed_date?: string;
  agency?: string;
  agency_name?: string;
  complaint_type?: string;
  descriptor?: string;
  location_type?: string;
  incident_zip?: string;
  incident_address?: string;
  street_name?: string;
  borough?: string;
  status?: string;
  resolution_description?: string;
  latitude?: string;
  longitude?: string;
}

function sanitizeLabel(s: string | undefined): string {
  if (!s) return 'unknown';
  // ltree labels: A-Z, a-z, 0-9, _ — and must be non-empty
  const cleaned = s.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.toLowerCase() || 'unknown';
}

function buildContent(r: Row311): string {
  const parts: string[] = [];
  if (r.complaint_type) parts.push(`Complaint: ${r.complaint_type}.`);
  if (r.descriptor)     parts.push(`Descriptor: ${r.descriptor}.`);
  if (r.location_type)  parts.push(`Location type: ${r.location_type}.`);
  if (r.incident_address) parts.push(`Address: ${r.incident_address}, ${r.borough ?? ''}.`);
  if (r.status)         parts.push(`Status: ${r.status}.`);
  if (r.resolution_description) parts.push(`Resolution: ${r.resolution_description}`);
  return parts.join(' ').trim();
}

function buildTree(r: Row311): string {
  return `nyc.${sanitizeLabel(r.borough)}.${sanitizeLabel(r.agency)}.${sanitizeLabel(r.complaint_type)}`;
}

function buildTemporal(r: Row311): string | null {
  if (!r.created_date) return null;
  const start = new Date(r.created_date).toISOString();
  if (r.closed_date) {
    const end = new Date(r.closed_date).toISOString();
    if (end > start) return `[${start},${end})`;
    return `[${start},${start}]`;
  }
  return `[${start},${start}]`;
}

function buildMeta(r: Row311): Record<string, any> {
  const m: Record<string, any> = { sr_number: r.unique_key };
  if (r.agency)        m.agency = r.agency;
  if (r.status)        m.status = r.status;
  if (r.complaint_type) m.complaint_type = r.complaint_type;
  if (r.descriptor)    m.descriptor = r.descriptor;
  if (r.borough)       m.borough = r.borough;
  if (r.incident_zip)  m.incident_zip = r.incident_zip;
  if (r.location_type) m.location_type = r.location_type;
  return m;
}

async function main() {
  const url = `https://data.cityofnewyork.us/resource/erm2-nwe9.json?$limit=${LIMIT}&$order=created_date DESC`;
  console.log(`Fetching ${LIMIT} rows from SODA...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SODA fetch failed: ${res.status} ${res.statusText}`);
  const rows: Row311[] = await res.json();
  console.log(`Got ${rows.length} rows. Inserting...`);

  let inserted = 0;
  for (const r of rows) {
    const content = buildContent(r);
    if (!content) continue; // skip empty rows
    const meta = buildMeta(r);
    const tree = buildTree(r);
    const temporal = buildTemporal(r);
    const lon = r.longitude ? Number(r.longitude) : null;
    const lat = r.latitude ? Number(r.latitude) : null;
    const hasGeom = lon !== null && lat !== null && !Number.isNaN(lon) && !Number.isNaN(lat);

    if (hasGeom) {
      await sql`
        insert into documents (content, meta, tree, temporal, geom)
        values (
          ${content},
          ${sql.json(meta)}::jsonb,
          ${tree}::ltree,
          ${temporal}::tstzrange,
          ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)
        )
      `;
    } else {
      await sql`
        insert into documents (content, meta, tree, temporal)
        values (
          ${content},
          ${sql.json(meta)}::jsonb,
          ${tree}::ltree,
          ${temporal}::tstzrange
        )
      `;
    }
    inserted++;
  }
  console.log(`Inserted ${inserted} documents.`);
  await sql.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
