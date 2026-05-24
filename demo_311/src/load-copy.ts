// Bulk loader using Postgres COPY. Replaces src/load.ts and avoids the
// jsonb-as-scalar-string trap entirely because COPY parses each field
// according to its column type — a jsonb field containing `{"a":1}` becomes
// an object, not a string scalar.
//
// Text-format COPY escape rules used below:
//   \\  -> backslash, \t -> tab, \n -> newline, \r -> carriage return.
// PostGIS geometry is written as EWKT (`SRID=4326;POINT(lon lat)`), which
// the column's input function parses.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
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
  city?: string;
  borough?: string;
  location_type?: string;
  latitude?: string;
  longitude?: string;
};

function ltreeLabel(s: string | undefined, fallback: string): string {
  if (!s) return fallback;
  const cleaned = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 256);
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

// Escape a value for COPY text format. \N is NULL.
function esc(v: string | null | undefined): string {
  if (v === null || v === undefined) return '\\N';
  return v
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

const raw = readFileSync(resolve(process.cwd(), 'data/raw.jsonl'), 'utf8');
const rows: Row[] = raw.split('\n').filter(l => l.trim().length > 0).map(l => JSON.parse(l) as Row);
console.log(`parsed ${rows.length} rows`);

const t0 = performance.now();

// Build the COPY payload as a single string. (For really large loads you'd
// stream — but 2000 rows fit in memory cheaply and this keeps the diff
// against the naive INSERT path small.)
const lines: string[] = [];
for (const r of rows) {
  const borough = ltreeLabel(r.borough, 'unknown');
  const agency  = ltreeLabel(r.agency, 'unknown');
  const ctype   = ltreeLabel(r.complaint_type, 'unknown');
  const tree    = `nyc.${borough}.${agency}.${ctype}`;

  const created = r.created_date;
  const closed  = r.closed_date;
  const temporal = closed && closed > created
    ? `[${created},${closed})`
    : `[${created},infinity)`;

  const lon = r.longitude ? parseFloat(r.longitude) : null;
  const lat = r.latitude  ? parseFloat(r.latitude)  : null;
  const geom = (lon !== null && lat !== null && Number.isFinite(lon) && Number.isFinite(lat))
    ? `SRID=4326;POINT(${lon} ${lat})`
    : null;

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

  // Column order matches the COPY header below.
  lines.push([
    esc(buildContent(r)),
    esc(JSON.stringify(meta)),
    esc(tree),
    esc(temporal),
    esc(geom),
  ].join('\t'));
}

const payload = lines.join('\n') + '\n';
console.log(`payload: ${(payload.length / 1024 / 1024).toFixed(2)} MiB`);

const writable = await sql`
  copy documents (content, meta, tree, temporal, geom) from stdin
`.writable();

await pipeline(Readable.from([payload]), writable);

const elapsed = (performance.now() - t0) / 1000;
console.log(`COPY done in ${elapsed.toFixed(2)}s (${(rows.length / elapsed).toFixed(0)} rows/s)`);

const [{ count }] = await sql<{ count: string }[]>`select count(*)::text as count from documents`;
const [{ q }] = await sql<{ q: string }[]>`select count(*)::text as q from embedding_queue where outcome is null`;
console.log(`documents=${count}, queue=${q}`);

await sql.end();
