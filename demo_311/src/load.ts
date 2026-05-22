// Load 10k NYC 311 service requests into the documents table.
// Source: https://data.cityofnewyork.us/resource/erm2-nwe9.json (Socrata)
//
// Each 311 row becomes one `documents` row:
//   content   — natural-language description (complaint type + descriptor + resolution + address)
//   meta      — JSONB with agency, status, borough, complaint_type, descriptor, address, zip
//   tree      — nyc.<borough>.<agency>.<complaint_type_slug>
//   temporal  — [created_date, closed_date) or [created_date, created_date] if still open
//   geom      — ST_SetSRID(ST_MakePoint(lon, lat), 4326) when coordinates present
//
// The enqueue trigger fires automatically on insert, so embeddings will be backfilled by the worker.

import './env.js';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const TOTAL = Number(process.env.LOAD_LIMIT ?? 10_000);
const PAGE  = 1000;
const APP_TOKEN = process.env.NYC_APP_TOKEN;

const sql = postgres(DATABASE_URL, { max: 4 });

type Row311 = {
  unique_key?: string;
  created_date?: string;
  closed_date?: string;
  agency?: string;
  agency_name?: string;
  complaint_type?: string;
  descriptor?: string;
  status?: string;
  resolution_description?: string;
  borough?: string;
  city?: string;
  incident_address?: string;
  incident_zip?: string;
  latitude?: string;
  longitude?: string;
};

function slug(s: string | undefined): string {
  if (!s) return 'unknown';
  return s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'unknown';
}

function buildContent(r: Row311): string {
  const parts: string[] = [];
  if (r.complaint_type) parts.push(`Complaint: ${r.complaint_type}.`);
  if (r.descriptor && r.descriptor !== r.complaint_type) parts.push(`Descriptor: ${r.descriptor}.`);
  if (r.incident_address) {
    parts.push(`Location: ${r.incident_address}${r.borough ? `, ${r.borough}` : ''}${r.incident_zip ? ` ${r.incident_zip}` : ''}.`);
  } else if (r.borough) {
    parts.push(`Borough: ${r.borough}.`);
  }
  if (r.agency_name) parts.push(`Agency: ${r.agency_name}.`);
  if (r.status) parts.push(`Status: ${r.status}.`);
  if (r.resolution_description) parts.push(`Resolution: ${r.resolution_description}`);
  return parts.join(' ').trim();
}

function buildMeta(r: Row311): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  if (r.unique_key)       m.unique_key = r.unique_key;
  if (r.agency)           m.agency = r.agency;
  if (r.agency_name)      m.agency_name = r.agency_name;
  if (r.complaint_type)   m.complaint_type = r.complaint_type;
  if (r.descriptor)       m.descriptor = r.descriptor;
  if (r.status)           m.status = r.status;
  if (r.borough)          m.borough = r.borough;
  if (r.city)             m.city = r.city;
  if (r.incident_address) m.incident_address = r.incident_address;
  if (r.incident_zip)     m.incident_zip = r.incident_zip;
  return m;
}

function buildTree(r: Row311): string {
  const borough = slug(r.borough || 'unknown_borough');
  const agency = slug(r.agency || 'unknown_agency');
  const complaint = slug(r.complaint_type || 'unknown_complaint');
  return `nyc.${borough}.${agency}.${complaint}`;
}

function buildTemporal(r: Row311): string | null {
  if (!r.created_date) return null;
  const created = new Date(r.created_date);
  if (isNaN(created.getTime())) return null;
  const createdIso = created.toISOString();
  if (r.closed_date) {
    const closed = new Date(r.closed_date);
    if (!isNaN(closed.getTime()) && closed.getTime() > created.getTime()) {
      return `[${createdIso},${closed.toISOString()})`;
    }
  }
  return `[${createdIso},${createdIso}]`;
}

function buildGeom(r: Row311): { lon: number; lat: number } | null {
  if (!r.latitude || !r.longitude) return null;
  const lat = parseFloat(r.latitude);
  const lon = parseFloat(r.longitude);
  if (isNaN(lat) || isNaN(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  return { lon, lat };
}

async function fetchPage(offset: number, limit: number): Promise<Row311[]> {
  const url = new URL('https://data.cityofnewyork.us/resource/erm2-nwe9.json');
  url.searchParams.set('$limit', String(limit));
  url.searchParams.set('$offset', String(offset));
  url.searchParams.set('$order', 'created_date DESC');
  // Filter to rows with a description and a location, so the data is useful for search
  url.searchParams.set('$where', "descriptor IS NOT NULL AND latitude IS NOT NULL");
  const headers: Record<string, string> = {};
  if (APP_TOKEN) headers['X-App-Token'] = APP_TOKEN;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Socrata returned ${res.status}: ${await res.text()}`);
  return res.json() as Promise<Row311[]>;
}

async function insertBatch(rows: Row311[]): Promise<number> {
  if (rows.length === 0) return 0;
  const values = rows.map(r => {
    const content = buildContent(r);
    if (!content) return null;
    const geo = buildGeom(r);
    return {
      content,
      meta: buildMeta(r),
      tree: buildTree(r),
      temporal: buildTemporal(r),
      lon: geo?.lon ?? null,
      lat: geo?.lat ?? null,
    };
  }).filter((v): v is NonNullable<typeof v> => v !== null);

  if (values.length === 0) return 0;

  // postgres-js doesn't have a clean bulk-insert with mixed-type values + ST_MakePoint,
  // so we unnest typed arrays in a single round trip.
  const contents = values.map(v => v.content);
  const metas    = values.map(v => JSON.stringify(v.meta));
  const trees    = values.map(v => v.tree);
  const temporals = values.map(v => v.temporal);
  const lons     = values.map(v => v.lon);
  const lats     = values.map(v => v.lat);

  await sql`
    insert into documents (content, meta, tree, temporal, geom)
    select c, m::jsonb, t::ltree, tr::tstzrange,
           case when lon is not null and lat is not null
                then ST_SetSRID(ST_MakePoint(lon, lat), 4326)
                else null end
    from unnest(
      ${contents}::text[],
      ${metas}::text[],
      ${trees}::text[],
      ${temporals as (string | null)[]}::text[],
      ${lons as (number | null)[]}::float8[],
      ${lats as (number | null)[]}::float8[]
    ) as t(c, m, t, tr, lon, lat)
  `;
  return values.length;
}

async function main() {
  console.log(`Loading up to ${TOTAL} rows in pages of ${PAGE}…`);
  let loaded = 0;
  let offset = 0;
  while (loaded < TOTAL) {
    const wantThisPage = Math.min(PAGE, TOTAL - loaded);
    const rows = await fetchPage(offset, wantThisPage);
    if (rows.length === 0) {
      console.log('No more rows from Socrata; stopping.');
      break;
    }
    const inserted = await insertBatch(rows);
    loaded += inserted;
    offset += rows.length;
    console.log(`  …${loaded} loaded (page returned ${rows.length}, inserted ${inserted})`);
  }
  const [{ count: docCount }] = await sql`select count(*)::int as count from documents`;
  const [{ count: queueCount }] = await sql`select count(*)::int as count from embedding_queue where outcome is null`;
  console.log(`Done. documents=${docCount}, pending embeddings=${queueCount}`);
  await sql.end();
}

main().catch(err => { console.error(err); process.exit(1); });
