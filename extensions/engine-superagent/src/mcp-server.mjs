import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { RPCLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import { createORPCClient } from '@orpc/client';
import { z } from 'zod';
import { WebSocket } from 'ws';

const gateway = process.argv[2];
if (!gateway?.startsWith('http://127.0.0.1:')) throw new Error('Expected loopback Gateway URL');
const client = createORPCClient(new RPCLink({ url: gateway }));
const server = new McpServer({ name: 'neo-agents', version: '0.1.0' }, { capabilities: { tools: {} } });
server.registerTool('agents.send_to_bot', {
  description: 'Delegate a ticket to a Neo Hermes bot and wait for its final status.',
  inputSchema: z.object({ botId: z.string().min(1), text: z.string().min(1) }),
}, async ({ botId, text }) => {
  try {
    const { turnId } = await client.agents.turns.send({ botId, text });
    const deadline = Date.now() + 90000;
    let status = 'queued';
    while (Date.now() < deadline) {
      const turns = await client.agents.turns.list({ botId });
      status = turns.find(turn => turn.id === turnId)?.status ?? 'unknown';
      if (!['queued', 'running', 'awaiting_approval'].includes(status)) break;
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    if (['queued', 'running', 'awaiting_approval'].includes(status)) {
      await client.agents.turns.stop({ turnId }).catch(() => {});
      throw new Error('Hermes bot turn timed out');
    }
    if (status !== 'completed') throw new Error(`Hermes bot turn ${status}`);
    // AgentService persists the complete stream and closes it on terminal status.
    // Replaying from sequence zero avoids losing final deltas to a subscribe race.
    const socket = new WebSocket(gateway.replace(/^http/, 'ws') + '/ws');
    let summary = '';
    try {
      const stream = createORPCClient(new WebSocketLink({ websocket: socket }));
      for await (const event of await stream.agents.turns.events({ turnId, since: 0 })) {
        if (event.kind === 'text.delta') summary += event.textDelta ?? '';
      }
    } finally {
      socket.close();
    }
    if (!summary.trim()) throw new Error(`Hermes bot turn ${turnId} produced no response text`);
    return { content: [{ type: 'text', text: JSON.stringify({ turnId, status, summary: summary.trim(), tests: [], risks: [] }) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: (error instanceof Error ? error.message : String(error)) }] };
  }
});
serveStdio(() => server);
