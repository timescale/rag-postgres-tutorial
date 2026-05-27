// mcp-server.ts — Step 7 from the tutorial, tailored to the 311 corpus.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchDocuments } from './search.js';

const server = new McpServer({
  name: 'nyc-311-documents',
  version: '0.1.0',
});

const nullish = <T extends z.ZodTypeAny>(s: T) =>
  s.optional().nullable().transform(v => v ?? undefined);

server.registerTool(
  'documents_search',
  {
    title: 'Search NYC 311 Service Requests',
    description: `Retrieve NYC 311 service-request rows. Each row's \`content\` is a single denormalized blob:
"<complaint_type>: <descriptor>. Address: <address>, <borough> <zip>. Status: <status>. <resolution_description>"

Modes:
- semantic — paraphrase / concept ("people partying late at night" → "Noise - Residential")
- fulltext — BM25 over the content blob; good for street names, descriptors, agency names
- both     — set semantic and fulltext to the same string for hybrid (RRF) ranking

Filter fields:
- tree     — path \`nyc.<borough>.<agency>.<complaint_type>\` with each label slugified
             (lowercase, [a-z0-9_]). Examples:
             "nyc.brooklyn.nypd"                    — everything from NYPD in Brooklyn
             "nyc.queens.dohmh.rodent"              — single complaint type
             Use the subtree containment operator implicitly (parent path matches all descendants).
- meta     — JSONB containment over { agency, agency_name, borough, city, status, complaint_type,
             descriptor, channel, council_district, zip, unique_key }.
             agency ∈ {NYPD, DOT, DSNY, DOB, DOHMH, HPD, DEP, DHS, …}
             status ∈ {Open, In Progress, Closed, Assigned, Pending, …}
             borough ∈ {BRONX, BROOKLYN, MANHATTAN, QUEENS, STATEN ISLAND, Unspecified}
- temporal — overlaps a window [from, to). The range stored is [created_date, closed_date),
             so "from=X, to=Y" matches any complaint whose lifecycle overlapped [X,Y).
- near     — { lon, lat, radiusMeters } against the incident location (WGS84).

Score scales: semantic ∈ [0,1] cosine sim; BM25 positive, unbounded; hybrid (RRF) small fused values;
filter-only is 1.0. When \`near\` is set every row carries \`meters\` (great-circle distance).`,
    inputSchema: {
      semantic: nullish(z.string()).describe('Natural language query for vector search'),
      fulltext: nullish(z.string()).describe('Keywords / phrases for BM25'),
      tree:     nullish(z.string()).describe('ltree path like nyc.brooklyn.nypd; matches the subtree'),
      meta:     nullish(z.record(z.string(), z.any())).describe('JSONB containment filter'),
      temporal: nullish(z.object({
        from: nullish(z.string()),
        to:   nullish(z.string()),
      })).describe('ISO timestamps; restrict to complaints whose [created,closed) overlaps [from,to)'),
      near:     nullish(z.object({
        lon: z.number(),
        lat: z.number(),
        radiusMeters: z.number(),
      })).describe('Geo filter: within radiusMeters of (lon, lat). Output adds `meters`.'),
      limit:    nullish(z.number().int()).describe('Max results (default 10, max 1000)'),
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
  },
  async (args) => {
    const results = await searchDocuments({
      semantic: args.semantic,
      fulltext: args.fulltext,
      tree:     args.tree,
      meta:     args.meta,
      temporal: args.temporal,
      near:     args.near,
      limit:    args.limit && args.limit > 0 ? Math.min(args.limit, 1000) : 10,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  },
);

await server.connect(new StdioServerTransport());
