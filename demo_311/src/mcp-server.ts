import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchDocuments } from './search.js';

const server = new McpServer({ name: '311-documents', version: '1.0.0' });

// Accept undefined, null, or missing on the way in; normalize output to T | undefined.
const nullish = <T extends z.ZodTypeAny>(s: T) =>
  s.optional().nullable().transform(v => v ?? undefined);

server.registerTool(
  'documents_search',
  {
    title: 'Search NYC 311 Service Requests',
    description: `Search and browse NYC 311 service requests (complaint reports) using text matching and/or filters.

Modes:
- semantic: natural-language query for vector search (e.g. "loud music at night")
- fulltext: BM25 keywords/phrases (e.g. "pothole", "rat sighting")
- both: hybrid (RRF). For ordinary queries set both to the same string.

Each row is a single 311 service request, with content = "Complaint / Descriptor / Address / Agency / Status / Resolution".

Filters (compose with each other and the text modes):
- tree: nyc.<borough>.<agency>.<complaint_type> path. Boroughs are
  brooklyn / manhattan / queens / bronx / staten_island.
  Agencies are nypd / hpd / dot / dep / dsny / dpr / dohmh / dhs / tlc / dcwp / ...
  Use 'nyc.brooklyn' to match all Brooklyn rows, 'nyc.brooklyn.nypd' to narrow further.
- meta: JSONB containment. Known keys:
    agency ∈ {NYPD, HPD, DOT, DEP, DSNY, DPR, DOHMH, DHS, TLC, DCWP, ...}
    complaint_type (free text, e.g. "Noise - Residential")
    descriptor (free text, e.g. "Loud Music/Party")
    status ∈ {Open, In Progress, Closed, ...}
    borough ∈ {BROOKLYN, MANHATTAN, QUEENS, BRONX, STATEN ISLAND}
    zip (5-digit string)
    channel ∈ {ONLINE, PHONE, MOBILE, UNKNOWN, ...}
- temporal: ISO timestamps; the row's temporal range is [created_date, closed_date) for closed tickets, or [created_date, infinity) for open ones (still active). Restricts to rows overlapping [from, to).
- near: { lon, lat, radiusMeters } around the incident location. Coordinates are WGS84; New York City is roughly lon=-74, lat=40.7. With no other query, results are ordered by distance.

Scores: BM25 returns positive similarity (higher = better, unbounded); semantic returns cosine similarity in [0, 1]; hybrid returns fused RRF scores (small numbers near 0.03); filter-only is 1.0. BM25 scores are not comparable across different queries.

Result rows have shape { id, content, meta, tree, score }. When the request includes \`near\`, each row also carries \`meters\` — the great-circle distance from the anchor to the incident location, regardless of which mode ranked the row. Use it to tell the user "how far" a hit is.`,
    inputSchema: {
      semantic: nullish(z.string())
        .describe('Natural language query for vector search'),
      fulltext: nullish(z.string())
        .describe('Keywords/phrases for BM25'),
      tree: nullish(z.string())
        .describe('Tree filter, e.g. nyc.brooklyn or nyc.brooklyn.nypd'),
      meta: nullish(z.record(z.string(), z.any()))
        .describe('JSONB containment filter, e.g. {"agency":"DSNY","status":"Open"}'),
      temporal: nullish(z.object({
        from: nullish(z.string()),
        to:   nullish(z.string()),
      })).describe('Restrict to rows whose temporal range overlaps [from, to) (ISO timestamps)'),
      near: nullish(z.object({
        lon: z.number(),
        lat: z.number(),
        radiusMeters: z.number(),
      })).describe('Restrict to rows within radiusMeters of (lon, lat)'),
      limit: nullish(z.number().int())
        .describe('Maximum results (default 10, max 1000)'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
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
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  },
);

await server.connect(new StdioServerTransport());
