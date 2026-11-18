import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.id === undefined) continue;
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 2,
    info: { name: 'scripted-second-provider', version: '1' }, capabilities: { session: {} } } });
  else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'second-provider-session', configOptions: [] } });
  else if (m.method === 'session/prompt') {
    appendFileSync(join(process.cwd(), 'provider-continuation.jsonl'), JSON.stringify(m.params) + '\n');
    send({ method: 'session/update', params: { sessionId: m.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Second provider continued the same feature thread.' } } } });
    send({ method: 'session/update', params: { sessionId: m.params.sessionId,
      update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' } } });
    send({ id: m.id, result: {} });
  } else if (m.method === 'session/load') send({ id: m.id, result: { configOptions: [] } });
  else send({ id: m.id, result: {} });
}
