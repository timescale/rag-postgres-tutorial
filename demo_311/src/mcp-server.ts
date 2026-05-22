// MCP server exposing `documents_search` to any MCP-capable client.
//
// Description is tailored to the NYC 311 corpus per Step 7's guidance —
// agents reading it should know exactly what meta keys, tree paths, and
// coordinate semantics this database holds.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchDocuments } from './search.js';

const server = new McpServer({
  name: 'nyc-311',
  version: '1.0.0',
});

server.registerTool(
  'documents_search',
  {
    title: 'Search NYC 311 Service Requests',
    description: `Search NYC 311 service requests (complaints filed by residents to city agencies).

Modes:
- semantic: natural-language query, vector similarity over content
- fulltext: BM25 keyword/phrase search over content
- both:    hybrid (RRF fusion). For ordinary queries, pass the same string to both.

Filters (combine freely with any mode):
- tree:     ltree path 'nyc.<borough>.<agency>.<complaint_type>'.
            Borough lowercase (manhattan, brooklyn, queens, bronx, staten_island).
            Agency lowercase (nypd, dot, dsny, hpd, dep, dohmh, ...).
            Use subtree match — 'nyc.manhattan' matches everything in Manhattan.
- meta:     JSONB containment over { agency, status, complaint_type, descriptor,
            borough, incident_zip, location_type, sr_number }.
- temporal: ISO timestamps; restricts to service requests whose
            [created_date, closed_date) range overlaps [from, to).
- near:     { lon, lat, radiusMeters }. Location is the incident location
            (lon/lat, WGS84). Sole filter -> results sorted by distance;
            combined with text/vector -> distance is a hard filter.

content is a denormalized blob of complaint_type + descriptor + address + status + resolution.
Score is RRF-style in hybrid, cosine similarity (0-1) in semantic, BM25 in fulltext.`,
    inputSchema: {
      semantic: z.string().optional().nullable()
        .describe('Natural language query for vector search'),
      fulltext: z.string().optional().nullable()
        .describe('Keywords/phrases for BM25'),
      tree: z.string().optional().nullable()
        .describe('Tree filter, e.g. nyc.manhattan or nyc.brooklyn.nypd'),
      meta: z.record(z.string(), z.any()).optional().nullable()
        .describe('JSONB containment, e.g. {"agency":"NYPD","status":"Closed"}'),
      temporal: z.object({
        from: z.string().optional().nullable(),
        to:   z.string().optional().nullable(),
      }).optional().nullable()
        .describe('ISO timestamps; overlap with [from,to) on the request lifecycle'),
      near: z.object({
        lon: z.number(),
        lat: z.number(),
        radiusMeters: z.number(),
      }).optional().nullable()
        .describe('Geo filter: WGS84 incident location within radiusMeters.'),
      limit: z.number().int().optional().nullable()
        .describe('Maximum results (default 10, max 1000)'),
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
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
      limit:    args.limit && args.limit > 0 ? args.limit : 10,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  },
);

await server.connect(new StdioServerTransport());
