import 'dotenv/config';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { max: 4 });

type Record311 = {
  unique_key: string;
  created_date?: string;
  closed_date?: string;
  agency?: string;
  agency_name?: string;
  complaint_type?: string;
  descriptor?: string;
  status?: string;
  resolution_description?: string;
  incident_address?: string;
  incident_zip?: string;
  city?: string;
  borough?: string;
  community_board?: string;
  latitude?: string;
  longitude?: string;
  open_data_channel_type?: string;
  location_type?: string;
  police_precinct?: string;
};

// ltree labels are restricted to [A-Za-z0-9_], max 256 chars.
function ltreeLabel(s: string | undefined): string {
  if (!s) return 'unknown';
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 250) || 'unknown';
}

function buildContent(r: Record311): string {
  const parts = [
    `Complaint: ${r.complaint_type ?? ''}`.trim(),
    r.descriptor ? `Descriptor: ${r.descriptor}` : null,
    r.incident_address ? `Address: ${r.incident_address}, ${r.borough ?? ''} ${r.incident_zip ?? ''}`.trim() : null,
    r.agency_name ? `Agency: ${r.agency_name}` : null,
    r.status ? `Status: ${r.status}` : null,
    r.resolution_description ? `Resolution: ${r.resolution_description}` : null,
  ].filter(Boolean);
  return parts.join('\n');
}

function buildTree(r: Record311): string {
  return [
    'nyc',
    ltreeLabel(r.borough),
    ltreeLabel(r.agency),
    ltreeLabel(r.complaint_type),
  ].join('.');
}

function buildTemporal(r: Record311): string | null {
  const start = r.created_date;
  if (!start) return null;
  const startIso = new Date(start).toISOString();
  if (r.closed_date) {
    const endIso = new Date(r.closed_date).toISOString();
    if (endIso > startIso) return `[${startIso},${endIso})`;
  }
  // Open ticket: a point-in-time event at created_date.
  return `[${startIso},${startIso}]`;
}

function buildGeom(r: Record311): { lon: number; lat: number } | null {
  if (!r.latitude || !r.longitude) return null;
  const lat = parseFloat(r.latitude);
  const lon = parseFloat(r.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lon, lat };
}

function buildMeta(r: Record311): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    unique_key: r.unique_key,
    type: '311_service_request',
  };
  if (r.agency) meta.agency = r.agency;
  if (r.complaint_type) meta.complaint_type = r.complaint_type;
  if (r.descriptor) meta.descriptor = r.descriptor;
  if (r.status) meta.status = r.status;
  if (r.borough) meta.borough = r.borough;
  if (r.incident_zip) meta.zip = r.incident_zip;
  if (r.open_data_channel_type) meta.channel = r.open_data_channel_type;
  if (r.location_type) meta.location_type = r.location_type;
  return meta;
}

async function main() {
  const path = process.argv[2] ?? 'data/nyc311.json';
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record311[];
  console.log(`Loaded ${raw.length} records from ${path}`);

  const t0 = Date.now();
  const BATCH = 200;
  let inserted = 0;

  for (let i = 0; i < raw.length; i += BATCH) {
    const slice = raw.slice(i, i + BATCH);

    const contents: string[] = [];
    const metas: string[] = [];
    const trees: string[] = [];
    const temporals: (string | null)[] = [];
    const lons: (number | null)[] = [];
    const lats: (number | null)[] = [];

    for (const r of slice) {
      contents.push(buildContent(r));
      metas.push(JSON.stringify(buildMeta(r)));
      trees.push(buildTree(r));
      temporals.push(buildTemporal(r));
      const g = buildGeom(r);
      lons.push(g?.lon ?? null);
      lats.push(g?.lat ?? null);
    }

    await sql`
      insert into documents (content, meta, tree, temporal, geom)
      select c, m::jsonb, t::ltree,
             case when tr is null then null else tr::tstzrange end,
             case when lon is null or lat is null then null
                  else ST_SetSRID(ST_MakePoint(lon, lat), 4326) end
      from unnest(
        ${contents}::text[],
        ${metas}::text[],
        ${trees}::text[],
        ${temporals}::text[],
        ${lons}::float8[],
        ${lats}::float8[]
      ) as t(c, m, t, tr, lon, lat)
    `;

    inserted += slice.length;
    if (inserted % 1000 === 0 || inserted === raw.length) {
      console.log(`  inserted ${inserted}/${raw.length}`);
    }
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`Done. Inserted ${inserted} rows in ${dt}s`);

  const [{ count: docCount }] = await sql<{ count: string }[]>`select count(*) from documents`;
  const [{ count: queueCount }] = await sql<{ count: string }[]>`select count(*) from embedding_queue where outcome is null`;
  console.log(`documents=${docCount}, embedding_queue(open)=${queueCount}`);

  await sql.end();
}

main().catch(err => { console.error(err); process.exit(1); });
