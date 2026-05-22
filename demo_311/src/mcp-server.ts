// MCP server — exposes searchDocuments as a single `documents_search` tool.
//
// The tool description is corpus-specific (NYC 311) — see the tutorial Step 7
// note on tailoring the description to your actual data.

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchDocuments } from './search.ts';

const server = new McpServer({
  name: 'nyc311-documents',
  version: '1.0.0',
});

const DESCRIPTION = `Search NYC 311 service requests.

Each row is one 311 complaint. The retrieval unit (\`content\`) is a denormalized
blob: complaint_type + descriptor + address + status + resolution_description.
Use it when the question is about what the complaint was, where it happened, or
how it was resolved.

Modes: semantic (meaning), fulltext (keywords), or both (hybrid).
For ordinary questions, set both semantic and fulltext to the same query.
Combine with tree, meta, temporal, and near filters. Scores 0-1.

Filter fields for this corpus:

- tree: nyc.<borough>.<agency>.<complaint_type>, lowercased+underscored.
  Borough ∈ {bronx, brooklyn, manhattan, queens, staten_island, unknown}.
  Agency ∈ {nypd, dot, dpr, dsny, dep, hpd, dhs, doh, …} (lowercased).
  Examples: nyc.brooklyn (all Brooklyn), nyc.brooklyn.nypd (all NYPD complaints
  in Brooklyn), nyc.queens.dot.street_condition (all DOT street-condition
  complaints in Queens).

- meta: JSONB containment. Useful keys:
  - agency        (e.g. "NYPD", "DOT", "DPR", "DSNY") — original case preserved here
  - complaint_type (e.g. "Noise - Residential", "Illegal Parking", "Street Condition")
  - descriptor    (e.g. "Loud Music/Party", "Pothole")
  - status        ("Open", "In Progress", "Closed") — case-sensitive
  - borough       ("BROOKLYN", "QUEENS", "BRONX", "MANHATTAN", "STATEN ISLAND") — uppercase
  - incident_zip  (5-digit string)
  - city          (the NYC sub-locality name, uppercase)

- temporal: ISO timestamps. Each complaint's range is [created_date, closed_date)
  for closed requests, and [created_date, created_date] for still-open ones.
  Pass {from, to} to find complaints whose lifetime overlaps that window.

- near: {lon, lat, radiusMeters}. The point is the incident location of the
  complaint. With no other text query, results are sorted by distance.`;

server.registerTool(
  'documents_search',
  {
    title: 'Search NYC 311 Service Requests',
    description: DESCRIPTION,
    inputSchema: {
      semantic: z.string().optional().nullable()
        .describe('Natural language query for vector search'),
      fulltext: z.string().optional().nullable()
        .describe('Keywords/phrases for BM25'),
      tree: z.string().optional().nullable()
        .describe('ltree path filter (subtree match)'),
      meta: z.record(z.string(), z.any()).optional().nullable()
        .describe('JSONB containment filter'),
      temporal: z.object({
        from: z.string().optional().nullable(),
        to:   z.string().optional().nullable(),
      }).optional().nullable()
        .describe('ISO timestamps; restrict to complaints whose lifetime overlaps [from, to)'),
      near: z.object({
        lon: z.number(),
        lat: z.number(),
        radiusMeters: z.number(),
      }).optional().nullable()
        .describe('Geo filter. With no other query, sorted by distance.'),
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
      limit:    args.limit && args.limit > 0 ? Math.min(args.limit, 1000) : 10,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  },
);

await server.connect(new StdioServerTransport());
