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
    const data = await response.json();
    const pending = action.operation === 'run' && data.status !== 'completed';
    const result = action.operation === 'toolkits' ? { summary: `${data.length} app toolkits available`, toolkits: data }
      : action.operation === 'connect' ? { ...data, summary: `Complete account authorization: ${data.redirectUrl}`, kind: 'question', question: `Open ${data.redirectUrl} and finish OAuth before running an action. This link does not confirm an active connection.` }
      : { ...data, summary: pending ? `Connected-app action awaits review in Inbox (${data.inboxId})`
          : `Connected-app action completed: ${JSON.stringify(data.result).slice(0, 4000)}`,
          ...(pending ? { kind: 'question', question: `Review request ${data.inboxId} in Inbox. Nothing has executed yet; do not resubmit this action automatically.` } : {}) };
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch { return { isError: true, content: [{ type: 'text', text: 'Apps capability unavailable; do not retry a side effect automatically' }] }; }
}
const provider = z.string().default('composio');
server.registerTool('toolkits', { description: 'List connected-app toolkits.', inputSchema: z.object({ provider }) }, args => action({ operation: 'toolkits', ...args }));
server.registerTool('connect', { description: 'Create an OAuth link; the human completes authorization. API keys stay in Neo vault.', inputSchema: z.object({ provider, toolkit: z.string(), authConfigId: z.string(), callbackUrl: z.string().url() }) }, args => action({ operation: 'connect', ...args }));
server.registerTool('run', { description: 'Run an action using a Neo-connected account. Workspace accept mode applies; destructive or unknown actions require Inbox approval. Pending approval means nothing has executed.', inputSchema: z.object({ provider, accountId: z.string(), action: z.string(), arguments: z.record(z.string(), z.unknown()) }) }, args => action({ operation: 'run', ...args }));
serveStdio(() => server);
