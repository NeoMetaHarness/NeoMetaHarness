// Isolated local MCP server; no model, credentials, or user DSH_HOME.
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const server = new McpServer(
  { name: 'neo-spike-fixture', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
);
server.registerTool('add', {
  description: 'Deterministic addition',
  inputSchema: z.object({ a: z.number(), b: z.number() }),
}, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));
server.registerTool('fail', {
  description: 'Deliberate MCP tool error', inputSchema: z.object({}),
}, async () => ({ content: [{ type: 'text', text: 'fixture failure' }], isError: true }));
serveStdio(() => server);
