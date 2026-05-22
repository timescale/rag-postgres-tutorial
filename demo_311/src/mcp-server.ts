// MCP server — exposes the 311 dataset to MCP-capable agents.
// Verbatim shape from Step 7 of the tutorial, with one extra `temporal` parameter
// since the tutorial's MCP example forgot to expose temporal filtering.

import './env.js';
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
    description: `Search and browse NYC 311 service requests using text matching and/or filters.

Modes:
  - semantic   (natural-language paraphrase / concept match)
  - fulltext   (BM25 keyword match — names, exact terms)
  - both       (hybrid, fused with Reciprocal Rank Fusion — recommended for free text)

Combine with:
  - tree       hierarchical filter, e.g. "nyc.brooklyn" (descendants included)
  - meta       JSONB containment, e.g. {"agency":"NYPD","status":"Open"}
  - temporal   { from, to } ISO timestamps; matches requests whose validity range overlaps
  - near       { lon, lat, radiusMeters } — geo filter. With no other query, results sorted by distance.

The tree taxonomy is nyc.<borough>.<agency_slug>.<complaint_type_slug>.
Results are scored 0-1 (semantic/fulltext) or 1.0 placeholder (filter-only).`,
    inputSchema: {
      semantic: z.string().optional().nullable()
        .describe('Natural language query for vector search'),
      fulltext: z.string().optional().nullable()
        .describe('Keywords/phrases for BM25'),
      tree: z.string().optional().nullable()
        .describe('Tree filter; "nyc.brooklyn" includes all descendants'),
      meta: z.record(z.string(), z.any()).optional().nullable()
        .describe('JSONB containment filter, e.g. {"agency":"NYPD"}'),
      temporal: z.object({
        from: z.string().optional().nullable(),
        to:   z.string().optional().nullable(),
      }).optional().nullable()
        .describe('ISO timestamps; matches requests whose temporal range overlaps [from, to)'),
      near: z.object({
        lon: z.number(),
        lat: z.number(),
        radiusMeters: z.number(),
      }).optional().nullable()
        .describe('Geo filter: documents within radiusMeters of (lon, lat). With no other query, sorted by distance.'),
      limit: z.number().int().optional().nullable()
        .describe('Maximum results (default 10, max 100)'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async (args) => {
    const limit = args.limit && args.limit > 0 ? Math.min(args.limit, 100) : 10;
    const results = await searchDocuments({
      semantic: args.semantic ?? undefined,
      fulltext: args.fulltext ?? undefined,
      tree:     args.tree ?? undefined,
      meta:     args.meta ?? undefined,
      temporal: args.temporal ?? undefined,
      near:     args.near ?? undefined,
      limit,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  },
);

await server.connect(new StdioServerTransport());
