import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
const server = new McpServer({ name: 'neo-apps', version: '0.1.0' }, { capabilities: { tools: {} } });
async function action(action) {
  try {
    const binding = JSON.parse(await readFile(process.env.NEO_APPS_MCP_BINDING, 'utf8'));
    const url = new URL(binding.endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/internal/apps-mcp/action') throw Error();
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${binding.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ engine: binding.engine, profile: binding.profile, action }) });
    if (!response.ok) throw Error();
    return { content: [{ type: 'text', text: JSON.stringify(await response.json()) }] };
  } catch { return { isError: true, content: [{ type: 'text', text: 'Apps capability unavailable; do not retry a side effect automatically' }] }; }
}
const provider = z.string().default('composio');
server.registerTool('toolkits', { description: 'List connected-app toolkits.', inputSchema: z.object({ provider }) }, args => action({ operation: 'toolkits', ...args }));
server.registerTool('connect', { description: 'Create an OAuth link; the human completes authorization. API keys stay in Neo vault.', inputSchema: z.object({ provider, toolkit: z.string(), authConfigId: z.string(), callbackUrl: z.string().url() }) }, args => action({ operation: 'connect', ...args }));
server.registerTool('run', { description: 'Run an action using a Neo-connected account. Workspace accept mode applies; destructive or unknown actions require Inbox approval. Pending approval means nothing has executed.', inputSchema: z.object({ provider, accountId: z.string(), action: z.string(), arguments: z.record(z.string(), z.unknown()) }) }, args => action({ operation: 'run', ...args }));
serveStdio(() => server);
