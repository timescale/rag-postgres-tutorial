// Spawns the MCP server over stdio, calls tools/list and a sample
// documents_search, and prints the response. Used to verify the server boots.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const proc = spawn('node_modules/.bin/tsx', [resolve('src/mcp-server.ts')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});

const rl = createInterface({ input: proc.stdout });

const pending = new Map<number, (msg: any) => void>();
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (typeof msg.id === 'number' && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  }
});

let nextId = 1;
function send(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((res) => {
    pending.set(id, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function main() {
  // 1. initialize
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoketest', version: '0.0.1' },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // 2. list tools
  const tools = await send('tools/list', {});
  console.log('--- tools/list ---');
  console.log(JSON.stringify(tools.result, null, 2));

  // 3. call documents_search
  const call = await send('tools/call', {
    name: 'documents_search',
    arguments: { fulltext: 'pothole', tree: 'nyc.brooklyn', limit: 2 },
  });
  console.log('--- documents_search ---');
  const text = call.result?.content?.[0]?.text;
  if (text) {
    const parsed = JSON.parse(text);
    console.log(`got ${parsed.length} rows`);
    for (const r of parsed) console.log(`  ${r.tree} score=${r.score.toFixed(4)} ${r.content.slice(0, 80)}...`);
  } else {
    console.log(JSON.stringify(call, null, 2));
  }

  proc.kill();
  process.exit(0);
}

await main();
