// Load NYC 311 JSON pages into `documents`.
// Methodology from the tutorial:
//   content   = descriptor + complaint_type + address (the retrieval unit text)
//   meta      = JSONB structured filters (agency, status, complaint_type, ...)
//   tree      = nyc.<borough>.<agency>.<complaint_type> (ltree labels sanitized)
//   temporal  = [created_date, closed_date) or [created_date, infinity)
//   geom      = ST_SetSRID(ST_MakePoint(lon, lat), 4326)
//
// Uses one bulk insert per page via `unnest`, per the tutorial's bulk-load note.
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });

// Sanitize an arbitrary string into an ltree label: [A-Za-z0-9_], <=256 chars.
function ltreeLabel(s: string | null | undefined): string {
  if (!s) return 'unknown';
  const cleaned = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return (cleaned || 'unknown').slice(0, 256);
}

type Row = {
  unique_key?: string;
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
  resolution_action_updated_date?: string;
  latitude?: string;
  longitude?: string;
};

function buildContent(r: Row): string {
  const parts: string[] = [];
  if (r.complaint_type) parts.push(`Complaint: ${r.complaint_type}`);
  if (r.descriptor) parts.push(`Descriptor: ${r.descriptor}`);
  if (r.location_type) parts.push(`Location type: ${r.location_type}`);
  const addr = [r.incident_address, r.city, r.borough, r.incident_zip].filter(Boolean).join(', ');
  if (addr) parts.push(`Address: ${addr}`);
  if (r.agency_name) parts.push(`Agency: ${r.agency_name}`);
  if (r.status) parts.push(`Status: ${r.status}`);
  if (r.resolution_description) parts.push(`Resolution: ${r.resolution_description}`);
  return parts.join('\n');
}

function buildMeta(r: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (r.unique_key) out.unique_key = r.unique_key;
  if (r.agency) out.agency = r.agency;
  if (r.complaint_type) out.complaint_type = r.complaint_type;
  if (r.descriptor) out.descriptor = r.descriptor;
  if (r.status) out.status = r.status;
  if (r.borough) out.borough = r.borough;
  if (r.incident_zip) out.zip = r.incident_zip;
  if (r.location_type) out.location_type = r.location_type;
  return out;
}

function buildTree(r: Row): string {
  return [
    'nyc',
    ltreeLabel(r.borough),
    ltreeLabel(r.agency),
    ltreeLabel(r.complaint_type),
  ].join('.');
}

function buildTemporal(r: Row): string | null {
  if (!r.created_date) return null;
  const start = new Date(r.created_date);
  if (Number.isNaN(start.getTime())) return null;
  const startIso = start.toISOString();
  if (r.closed_date) {
    const end = new Date(r.closed_date);
    if (!Number.isNaN(end.getTime()) && end.getTime() > start.getTime()) {
      return `[${startIso},${end.toISOString()})`;
    }
  }
  return `[${startIso},infinity)`;
}

function buildGeom(r: Row): { lon: number; lat: number } | null {
  if (!r.latitude || !r.longitude) return null;
  const lat = Number(r.latitude);
  const lon = Number(r.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lon, lat };
}

async function loadPage(path: string): Promise<number> {
  const raw = await readFile(path, 'utf8');
  const rows = JSON.parse(raw) as Row[];

  const contents: string[] = [];
  const metas: string[] = [];
  const trees: string[] = [];
  const temporals: (string | null)[] = [];
  const lons: (number | null)[] = [];
  const lats: (number | null)[] = [];

  for (const r of rows) {
    const content = buildContent(r);
    if (!content) continue;
    contents.push(content);
    metas.push(JSON.stringify(buildMeta(r)));
    trees.push(buildTree(r));
    temporals.push(buildTemporal(r));
    const g = buildGeom(r);
    lons.push(g?.lon ?? null);
    lats.push(g?.lat ?? null);
  }

  if (contents.length === 0) return 0;

  // One bulk insert per page via unnest.
  await sql`
    insert into documents (content, meta, tree, temporal, geom)
    select
      t.content,
      t.meta::jsonb,
      t.tree::ltree,
      case when t.temporal is null then null else t.temporal::tstzrange end,
      case
        when t.lon is null or t.lat is null then null
        else ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326)
      end
    from unnest(
      ${contents}::text[],
      ${metas}::text[],
      ${trees}::text[],
      ${temporals as (string | null)[]}::text[],
      ${lons as (number | null)[]}::float8[],
      ${lats as (number | null)[]}::float8[]
    ) as t(content, meta, tree, temporal, lon, lat)
  `;

  return contents.length;
}

async function main() {
  const files = (await readdir('data'))
    .filter(f => f.startsWith('page-') && f.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    console.error('No data/page-*.json files. Run `npm run fetch` first.');
    process.exit(1);
  }
  let total = 0;
  const t0 = Date.now();
  for (const f of files) {
    const n = await loadPage(join('data', f));
    total += n;
    console.log(`loaded ${n.toString().padStart(4)} from ${f} (running total ${total})`);
  }
  console.log(`\nloaded ${total} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await sql.end();
}

await main();
