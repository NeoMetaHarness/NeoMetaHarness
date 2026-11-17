import readline from 'node:readline';

// Minimal ACP v2 over newline-delimited JSON-RPC. No model, tools, network or accounts.
// stdout is reserved for protocol frames; diagnostics go to stderr.
const sessionId = 'nmh-fake-acp-session';
let nextId = 100;
const pending = new Map();
const write = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
const notify = (method, params) => write({ method, params });
const ask = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  write({ id, method, params });
});

async function respondToRequest(frame) {
  const { id, method, params = {} } = frame;
  if (method === 'initialize') return { protocolVersion: 2, info: { name: 'nmh-fake-acp', version: '0.0.1' }, capabilities: { session: {} } };
  if (method === 'session/new') return { sessionId, configOptions: [] };
  if (method === 'session/load') return { configOptions: [] };
  if (method === 'session/cancel') return {};
  if (method === 'session/prompt') {
    const sid = params.sessionId ?? sessionId;
    const update = (value) => notify('session/update', { sessionId: sid, update: value });
    update({ sessionUpdate: 'agent_message_chunk', messageId: 'nmh-fake-msg', content: { type: 'text', text: 'neo fake streamed ' } });
    update({ sessionUpdate: 'agent_message_chunk', messageId: 'nmh-fake-msg', content: { type: 'text', text: 'text, part two.' } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'nmh-tool-1', title: 'Safe fake command', kind: 'execute', status: 'in_progress', rawInput: { command: 'echo MOCK_ONLY' } });
    const permission = await ask('session/request_permission', {
      sessionId: sid,
      title: 'Approve harmless fake operation?',
      subject: { type: 'tool_call', toolCall: { toolCallId: 'nmh-tool-1', title: 'Safe fake command', kind: 'execute', status: 'pending', rawInput: { command: 'echo MOCK_ONLY' } } },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const outcome = permission?.outcome;
    const declined = outcome?.outcome === 'selected' && outcome?.optionId === 'reject_once';
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'nmh-tool-1', status: 'completed', rawOutput: { mockOnly: true, declined } });
    update({ sessionUpdate: 'agent_message_chunk', messageId: 'nmh-fake-msg', content: { type: 'text', text: declined ? ' Approval declined.' : ' Approval was not declined.' } });
    // ACP v2 agents signal turn completion through state_update before replying to the prompt.
    update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
    return {};
  }
  throw new Error(`Unsupported ACP method: ${method}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let frame;
  try { frame = JSON.parse(line); } catch { process.stderr.write('Invalid JSON-RPC frame\n'); continue; }
  if (frame.id !== undefined && frame.method === undefined) {
    const promise = pending.get(frame.id);
    if (promise) {
      pending.delete(frame.id);
      if (frame.error) promise.reject(new Error(String(frame.error.message ?? 'ACP error')));
      else promise.resolve(frame.result);
    }
    continue;
  }
  if (!frame.method) continue;
  if (frame.id === undefined) continue;
  void respondToRequest(frame).then((result) => write({ id: frame.id, result })).catch((error) => write({ id: frame.id, error: { code: -32603, message: String(error.message) } }));
}
