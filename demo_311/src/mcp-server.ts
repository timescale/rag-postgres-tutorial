// MCP server, per Step 7 of the tutorial. Exposes documents_search.
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchDocuments } from './search.js';

const server = new McpServer({
  name: 'documents',
  version: '1.0.0',
});

const nullish = <T extends z.ZodTypeAny>(s: T) =>
  s.optional().nullable().transform(v => v ?? undefined);

server.registerTool(
  'documents_search',
  {
    title: 'Search NYC 311 Service Requests',
    description: `Search NYC 311 service requests using text matching and/or filters.

Modes: semantic (meaning), fulltext (keywords / BM25), or both (hybrid via RRF).
For ordinary queries, set both semantic and fulltext to the same query string.
Combine with tree, meta, temporal, and near (geo) filters.

content is a concatenation of complaint_type, descriptor, agency_name, status,
address, and resolution_description for each ticket.

meta keys you can filter on:
  - agency: NYPD | DOT | DSNY | HPD | DEP | DOHMH | DHS | DPR (top values)
  - status: Open | In Progress | Closed | Started | Unspecified
  - complaint_type: e.g. "Noise - Residential", "Illegal Parking", "Street Condition"
  - borough: BRONX | BROOKLYN | MANHATTAN | QUEENS | STATEN ISLAND
  - is_closed: boolean

tree layout: nyc.<borough>.<agency>.<complaint_type>
  e.g. nyc.brooklyn or nyc.manhattan.nypd or nyc.queens.dot.street_condition
  (labels are lowercased and non-alphanumerics become underscores).

temporal is [created_date, closed_date) for closed tickets,
[created_date, +infinity) for still-open tickets.

near.lon/lat are in WGS84 (decimal degrees). Every returned row carries a
meters field with great-circle distance to the anchor.

Each result row is { id, content, meta, tree, score }. Score scales:
semantic is cosine similarity in [0,1]; BM25 is positive and unbounded
(not comparable across queries); hybrid (RRF) returns small fused values;
filter-only is 1.0.`,
    inputSchema: {
      semantic: nullish(z.string())
        .describe('Natural language query for vector search'),
      fulltext: nullish(z.string())
        .describe('Keywords/phrases for BM25'),
      tree: nullish(z.string())
        .describe('Tree filter. nyc.brooklyn matches Brooklyn; nyc.* includes the whole city.'),
      meta: nullish(z.record(z.string(), z.any()))
        .describe('JSONB containment filter, e.g. {"agency":"DOT","status":"Open"}'),
      temporal: nullish(z.object({
        from: nullish(z.string()),
        to:   nullish(z.string()),
      })).describe('ISO timestamps; restrict to tickets whose [created,closed) range overlaps [from,to)'),
      near: nullish(z.object({
        lon: z.number(),
        lat: z.number(),
        radiusMeters: z.number(),
      })).describe('Geo filter: restrict to tickets within radiusMeters of (lon, lat). Every returned row carries a `meters` field. With no text/vector query, results sort by distance; otherwise text/vector score drives the order.'),
      limit: nullish(z.number().int())
        .describe('Maximum results (default 10, max 1000)'),
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
