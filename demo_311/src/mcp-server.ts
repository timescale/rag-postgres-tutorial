import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchDocuments } from './search.js';

const server = new McpServer({ name: '311-documents', version: '1.0.0' });

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
- temporal: ISO timestamps; the row's temporal range is [created_date, closed_date) for closed tickets, or a point at created_date for open ones. Restricts to rows overlapping [from, to).
- near: { lon, lat, radiusMeters } around the incident location. Coordinates are WGS84; New York City is roughly lon=-74, lat=40.7. With no other query, results are ordered by distance.

Scores: BM25 returns positive similarity (higher = better, unbounded); semantic returns cosine similarity in [0, 1]; hybrid returns fused RRF scores (small numbers near 0.03); filter-only is 1.0. BM25 scores are not comparable across different queries.

Result rows have shape { id, content, meta, tree, score }. When the request includes \`near\`, each row also carries \`meters\` — the great-circle distance from the anchor to the incident location, regardless of which mode ranked the row. Use it to tell the user "how far" a hit is.`,
    inputSchema: {
      semantic: z.string().optional().nullable()
        .describe('Natural language query for vector search'),
      fulltext: z.string().optional().nullable()
        .describe('Keywords/phrases for BM25'),
      tree: z.string().optional().nullable()
        .describe('Tree filter, e.g. nyc.brooklyn or nyc.brooklyn.nypd'),
      meta: z.record(z.string(), z.any()).optional().nullable()
        .describe('JSONB containment filter, e.g. {"agency":"DSNY","status":"Open"}'),
      temporal: z.object({
        from: z.string().optional().nullable(),
        to:   z.string().optional().nullable(),
      }).optional().nullable()
        .describe('Restrict to rows whose temporal range overlaps [from, to) (ISO timestamps)'),
      near: z.object({
        lon: z.number(),
        lat: z.number(),
        radiusMeters: z.number(),
      }).optional().nullable()
        .describe('Restrict to rows within radiusMeters of (lon, lat)'),
      limit: z.number().int().optional().nullable()
        .describe('Maximum results (default 10, max 1000)'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async (args) => {
    const results = await searchDocuments({
      semantic: args.semantic ?? undefined,
      fulltext: args.fulltext ?? undefined,
      tree:     args.tree ?? undefined,
      meta:     args.meta ?? undefined,
      temporal: args.temporal ? {
        from: args.temporal.from ?? undefined,
        to:   args.temporal.to   ?? undefined,
      } : undefined,
      near:     args.near ?? undefined,
      limit:    args.limit && args.limit > 0 ? Math.min(args.limit, 1000) : 10,
    });
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  },
);

await server.connect(new StdioServerTransport());
