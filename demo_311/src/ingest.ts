// Load NYC 311 service requests from data/nyc311.jsonl into the documents table.
//
// content   = a denormalized blob: complaint type, descriptor, address, status,
//             resolution. This is what BM25 and the embedding model see.
// meta      = structured attrs: unique_key, agency, complaint_type, descriptor,
//             status, borough, zip, address.
// tree      = nyc.<borough>.<agency>.<complaint_type>  (lowercased, sanitized)
// temporal  = [created_date, closed_date) when closed; [created_date, created_date]
//             otherwise (point-in-time still-open).
// geom      = ST_MakePoint(longitude, latitude) when both are present.

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postgres from 'postgres';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sql = postgres(process.env.DATABASE_URL!, { max: 4 });

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
  city?: string;
  borough?: string;
  status?: string;
  resolution_description?: string;
  latitude?: string;
  longitude?: string;
}

function sanitizeLtreeLabel(s: string): string {
  // ltree labels are [A-Za-z0-9_], max 256 chars. Lowercase, replace anything
  // else with _, collapse repeats, trim.
  const cleaned = s.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length === 0 ? 'unknown' : cleaned.slice(0, 256);
}

function buildContent(r: Row311): string {
  const parts: string[] = [];
  if (r.complaint_type) parts.push(`Complaint: ${r.complaint_type}`);
  if (r.descriptor)     parts.push(`Descriptor: ${r.descriptor}`);
  if (r.incident_address || r.street_name) {
    parts.push(`Address: ${[r.incident_address, r.street_name].filter(Boolean).join(', ')}`);
  }
  if (r.borough)        parts.push(`Borough: ${r.borough}`);
  if (r.city)           parts.push(`City: ${r.city}`);
  if (r.status)         parts.push(`Status: ${r.status}`);
  if (r.resolution_description) parts.push(`Resolution: ${r.resolution_description}`);
  return parts.join('\n');
}

function buildTree(r: Row311): string {
  const borough = sanitizeLtreeLabel(r.borough ?? 'unknown');
  const agency  = sanitizeLtreeLabel(r.agency ?? 'unknown');
  const ctype   = sanitizeLtreeLabel(r.complaint_type ?? 'unknown');
  return `nyc.${borough}.${agency}.${ctype}`;
}

function buildTemporal(r: Row311): string | null {
  if (!r.created_date) return null;
  const start = r.created_date;
  if (r.closed_date && r.closed_date > start) {
    return `[${start},${r.closed_date})`;
  }
  return `[${start},${start}]`;
}

function buildGeom(r: Row311): { lon: number; lat: number } | null {
  if (!r.longitude || !r.latitude) return null;
  const lon = Number(r.longitude);
  const lat = Number(r.latitude);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { lon, lat };
}

async function main() {
  const dataPath = path.resolve(__dirname, '..', 'data', 'nyc311.jsonl');
  const raw = await readFile(dataPath, 'utf8');
  const rows: Row311[] = raw.trim().split('\n').map(line => JSON.parse(line));
  console.log(`Loaded ${rows.length} rows from ${dataPath}`);

  const BATCH = 200;
  let inserted = 0;
  const t0 = Date.now();

  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const values = slice.map(r => {
      const geom = buildGeom(r);
      return {
        content: buildContent(r),
        meta: {
          unique_key: r.unique_key,
          agency: r.agency ?? null,
          agency_name: r.agency_name ?? null,
          complaint_type: r.complaint_type ?? null,
          descriptor: r.descriptor ?? null,
          location_type: r.location_type ?? null,
          status: r.status ?? null,
          borough: r.borough ?? null,
          incident_zip: r.incident_zip ?? null,
          incident_address: r.incident_address ?? null,
          city: r.city ?? null,
        },
        tree: buildTree(r),
        temporal: buildTemporal(r),
        lon: geom?.lon ?? null,
        lat: geom?.lat ?? null,
      };
    });

    await sql`
      insert into documents (content, meta, tree, temporal, geom)
      select
        v.content,
        v.meta::jsonb,
        v.tree::ltree,
        case when v.temporal is not null then v.temporal::tstzrange end,
        case when v.lon is not null and v.lat is not null
             then ST_SetSRID(ST_MakePoint(v.lon, v.lat), 4326)
        end
      from jsonb_to_recordset(${sql.json(values as any)}::jsonb) as v(
        content text, meta jsonb, tree text, temporal text, lon float8, lat float8
      )
    `;

    inserted += slice.length;
    process.stdout.write(`\rInserted ${inserted}/${rows.length}`);
  }

  const dt = Date.now() - t0;
  console.log(`\nDone in ${(dt / 1000).toFixed(1)}s. Inserted ${inserted} rows.`);
  await sql.end();
}

main().catch(async err => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
