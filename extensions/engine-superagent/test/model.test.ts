import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { modelHubFactory } from '../src/model.js';

type Request = { headers: { authorization?: string }; body: {
  model: string;
  messages: { role: string; content: string }[];
  tools?: { function: { name: string } }[];
} };

const seen: Request[] = [];
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions');
    const buffers: Buffer[] = [];
    for await (const part of request) buffers.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(buffers).toString()) as Request['body'];
    seen.push({ headers: { authorization: request.headers.authorization }, body });
    const message = seen.length === 1
      ? { content: '{"decision":"accept"}' }
      : { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: {
        name: 'mcp__neo__agents_send_to_bot_1234', arguments: '{"botId":"bot","text":"hello"}',
      } }] };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message }] }));
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});

try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const resolved: { role: string; profile?: string }[] = [];
  const models = modelHubFactory(() => ({
    active: true,
    async resolve(role, profile) {
      resolved.push({ role, profile });
      return { baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: role === 'eval' ? 'fake-eval' : 'fake-coding', apiKey: 'local-test-token' };
    },
  }));
  const input = { botId: 'bot', text: 'hello' };
  const evaluation = await models('eval', input);
  const worker = await models('worker', input);
  const nextWorker = await models('worker', input);
  assert.notEqual(worker.provider, nextWorker.provider, 'concurrent workers require separate adapter registrations');

  const message = createUserMessage({ content: [{ type: 'text', text: JSON.stringify(input) }], source: { kind: 'user' } });
  let decision = '';
  for await (const chunk of evaluation.adapter.stream({
    provider: evaluation.provider, model: evaluation.model, messages: [message],
  })) {
    if (chunk.type === 'block-end' && chunk.block.type === 'text') decision += chunk.block.text;
  }
  assert.deepEqual(JSON.parse(decision), { decision: 'accept' });

  let tool = '';
  for await (const chunk of worker.adapter.stream({
    provider: worker.provider, model: worker.model, messages: [message],
    tools: [{ name: 'mcp__neo__agents_send_to_bot_1234', description: 'Delegate to bot',
      parameters: { type: 'object', properties: { botId: { type: 'string' }, text: { type: 'string' } } } }],
  })) {
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') tool = chunk.block.name;
  }
  assert.equal(tool, 'mcp__neo__agents_send_to_bot_1234');
  assert.equal(seen.length, 2);
  assert.ok(seen.every((request) => request.headers.authorization === 'Bearer local-test-token'));
  assert.ok(seen[0]!.body.messages[0]!.content.includes('task evaluator'));
  assert.ok(seen[1]!.body.messages[0]!.content.includes('delegation worker'));
  assert.equal(seen[1]!.body.tools?.[0]?.function.name, tool);
  assert.deepEqual(resolved.map(({ role, profile }) => [role, profile]),
    [['eval', 'bot'], ['coding', 'bot'], ['coding', 'bot']]);
  assert.deepEqual(seen.map((request) => request.body.model), ['fake-eval', 'fake-coding']);
  console.log('SUPERAGENT_MODEL PASS hub_roles=eval,coding auth=true tool_calls=true unique_workers=true');
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
