import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
const server = new McpServer({ name: 'neo-computers', version: '0.1.0' }, { capabilities: { tools: {} } });
async function act(action) {
  try {
    // Re-read on every call so disable, reassignment and token rotation take effect immediately.
    const binding = JSON.parse(await readFile(process.env.NEO_COMPUTER_MCP_BINDING, 'utf8'));
    const url = new URL(binding.endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/internal/computers-mcp/action') throw Error();
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${binding.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ engine: binding.engine, profile: binding.profile, action }) });
    const result = await response.json();
    if (!response.ok) return { isError: true, content: [{ type: 'text', text: result.error ?? 'Computer capability unavailable' }] };
    if (result.capture) return { content: [{ type: 'image', mimeType: 'image/png', data: result.capture.png }] };
    return { content: [{ type: 'text', text: JSON.stringify(result.lease ?? { ok: true }) }] };
  } catch { return { isError: true, content: [{ type: 'text', text: 'Computer MCP projection is unavailable' }] }; }
}
server.registerTool('screenshot', { description: 'Capture the assigned computer; respects human lease and kill switch.', inputSchema: z.object({}).strict() }, () => act({ action: 'capture' }));
server.registerTool('click', { description: 'Click the assigned computer.', inputSchema: z.object({ x: z.number().finite(), y: z.number().finite() }).strict() }, (args) => act({ action: 'click', ...args }));
server.registerTool('type', { description: 'Type text on the assigned computer.', inputSchema: z.object({ text: z.string().max(10000) }).strict() }, (args) => act({ action: 'type', ...args }));
server.registerTool('key', { description: 'Press keys; destructive keys require operator policy.', inputSchema: z.object({ keys: z.string().min(1).max(256) }).strict() }, (args) => act({ action: 'key', ...args }));
server.registerTool('navigate', { description: 'Navigate to an operator-allowed HTTP(S) origin, if supported.', inputSchema: z.object({ url: z.string().url().max(4096) }).strict() }, (args) => act({ action: 'navigate', ...args }));
server.registerTool('lease_status', { description: 'Read lease holder and kill-switch status without changing the lease.', inputSchema: z.object({}).strict() }, () => act({ action: 'status' }));
serveStdio(() => server);
