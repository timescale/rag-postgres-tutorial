// MCP server — Step 7 of the tutorial, lightly adapted for the 311 corpus.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchDocuments } from './search.js';

const server = new McpServer({
  name: 'demo-311',
  version: '1.0.0',
});

const nullish = <T extends z.ZodTypeAny>(s: T) =>
  s.optional().nullable().transform(v => v ?? undefined);

server.registerTool(
  'documents_search',
  {
    title: 'Search NYC 311 Service Requests',
    description: `Search NYC 311 Service Requests by text, semantics, or filters.

content: concatenated descriptor + complaint_type + address + agency_name + status.
meta keys: agency (NYPD, DOT, DSNY, DOHMH, DEP, HPD, DPR, DCWP, TLC, ...),
  complaint_type, descriptor, status (Open, In Progress, Closed, ...),
  borough, zip, location_type, unique_key.
tree: nyc.<borough>.<agency>.<complaint_type>, all labels lowercased + underscored.
near: incident lat/lon (WGS84); 'meters' field carries actual distance.
temporal: [created_date, closed_date) for closed requests; [created_date, infinity) for open.

For ordinary free-text queries, set semantic and fulltext to the same string.`,
    inputSchema: {
      semantic: nullish(z.string()),
      fulltext: nullish(z.string()),
      tree: nullish(z.string()),
      meta: nullish(z.record(z.string(), z.any())),
      temporal: nullish(z.object({
        from: nullish(z.string()),
        to: nullish(z.string()),
      })),
      near: nullish(z.object({
        lon: z.number(),
        lat: z.number(),
        radiusMeters: z.number(),
      })),
      limit: nullish(z.number().int()),
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
      tree: args.tree,
      meta: args.meta,
      temporal: args.temporal,
      near: args.near,
      limit: args.limit && args.limit > 0 ? Math.min(args.limit, 1000) : 10,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  },
);

await server.connect(new StdioServerTransport());
