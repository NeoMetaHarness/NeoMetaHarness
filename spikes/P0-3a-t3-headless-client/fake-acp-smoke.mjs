import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const child = spawn(process.execPath, [new URL('./fake-acp.mjs', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')], { stdio: ['pipe', 'pipe', 'pipe'] });
const lines = readline.createInterface({ input: child.stdout });
const responses = new Map();
const events = [];
const send = (frame) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
let permissionDeclined = false;
let seenPermission = false;
const finished = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('ACP mock timed out')), 5000);
  lines.on('line', (line) => {
    const frame = JSON.parse(line);
    if (frame.method === 'session/update') events.push(frame.params.update);
    if (frame.method === 'session/request_permission') {
      seenPermission = true;
      assert.equal(frame.params.options.at(-1).kind, 'reject_once');
      send({ id: frame.id, result: { outcome: { outcome: 'selected', optionId: 'reject_once' } } });
      permissionDeclined = true;
    }
    if (frame.id === 3 && frame.result) {
      clearTimeout(timeout);
      resolve(frame.result);
    }
    if (frame.error) { clearTimeout(timeout); reject(new Error(frame.error.message)); }
  });
  child.on('error', reject);
});
send({ id: 1, method: 'initialize', params: { protocolVersion: 2, clientInfo: { name: 'nmh-test', version: '0' }, capabilities: {} } });
send({ id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
send({ id: 3, method: 'session/prompt', params: { sessionId: 'nmh-fake-acp-session', prompt: [{ type: 'text', text: 'hello' }] } });
try {
  const final = await finished;
  assert.ok(final);
  assert.ok(events.some((event) => event.sessionUpdate === 'state_update' && event.state === 'idle' && event.stopReason === 'end_turn'));
  assert.ok(seenPermission && permissionDeclined);
  const text = events.filter((event) => event.sessionUpdate === 'agent_message_chunk').map((event) => event.content.text).join('');
  assert.equal(text, 'neo fake streamed text, part two. Approval declined.');
  assert.ok(events.some((event) => event.sessionUpdate === 'tool_call_update'));
  console.log('fake_acp=PASS initialize session/new session/prompt chunk_count=3 permission=reject_once final=end_turn');
} finally {
  child.kill();
}
