import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { startGateway } from '../../../apps/gateway/src/server.js';
import { MODEL_ROLES } from '../../models/src/hub.js';

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const home = await mkdtemp(join(tmpdir(), 'neo-p29-'));
const secret = 'FAKE_MODEL_KEY_NEVER_OUTPUT_P29';
const calls: string[] = [];
const routed: { text: string; kind_hint: string }[] = [];
let delayFast = false;
const fake = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/route') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      task: { text: string; kind_hint: string }; pool: string[];
    };
    routed.push(body.task);
    res.end(JSON.stringify({ choice: { model_id: body.pool[0] } }));
    return;
  }
  if (req.url?.endsWith('/chat/completions')) {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string };
    calls.push(body.model);
    if (delayFast && body.model === 'tier-fast') {
      await new Promise((done) => setTimeout(done, 300));
    }
    if (body.model === 'tier-fast') { res.writeHead(503).end('{"error":"scripted"}'); return; }
    const content = body.model === 'tier-eval' ? '{"decision":"decline"}'
      : '{"decision":"accept"}';
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>((done) => fake.listen(0, '127.0.0.1', done));
const address = fake.address();
assert.ok(address && typeof address !== 'string');
const endpoint = `http://127.0.0.1:${address.port}`;

const extensionsDir = join(home, 'extensions-source');
await mkdir(extensionsDir);
for (const id of ['models', 'models-router-panda']) {
  const source = join(repo, 'extensions', id);
  const manifest = JSON.parse(await readFile(join(source, 'neo.extension.json'), 'utf8'));
  manifest.runtime.entry = './index.mjs';
  await mkdir(join(extensionsDir, id));
  await writeFile(join(extensionsDir, id, 'neo.extension.json'), JSON.stringify(manifest));
  await writeFile(join(extensionsDir, id, 'index.mjs'),
    `export { default } from ${JSON.stringify(pathToFileURL(join(source, 'src', 'index.ts')).href)};`);
}
await mkdir(join(extensionsDir, 'probe'));
await writeFile(join(extensionsDir, 'probe', 'neo.extension.json'), JSON.stringify({
  id: 'probe', version: '0.1.0', displayName: 'Escalation test', kind: ['tool'],
  runtime: { type: 'cordis', entry: './index.mjs' }, dependsOn: { models: '*' },
}));
const hubModule = pathToFileURL(join(repo, 'extensions', 'models', 'src', 'hub.ts')).href;
const superagentModel = pathToFileURL(join(repo, 'extensions', 'engine-superagent', 'src', 'model.ts')).href;
await writeFile(join(extensionsDir, 'probe', 'index.mjs'), `
import { ModelRouteRejected } from ${JSON.stringify(hubModule)};
import { modelHubFactory } from ${JSON.stringify(superagentModel)};
export default { activate(ctx) {
  const hub = ctx.inject('modelHub');
  ctx.route('run', async ({body}) => {
    const task = { text: body.text, source: 'neo/test', ticketId: body.ticketId };
    const execute = async (binding, signal) => {
      const response = await fetch(binding.baseUrl + '/chat/completions', {
        method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + binding.apiKey },
        body: JSON.stringify({ model: binding.model }),
      });
      if (!response.ok) throw new Error('Model turn failed');
      const result = await response.json();
      if (body.reject && JSON.parse(result.choices[0].message.content).decision === 'decline') {
        throw new ModelRouteRejected('Superagent Eval declined the proposed ticket');
      }
      return binding.model;
    };
    return hub.runRoutedTurn(body.role, body.profile, task, (binding, {signal}) => execute(binding, signal));
  });
  ctx.route('eval', async ({body}) => {
    const factory = modelHubFactory(() => hub);
    const initial = await factory('eval', { botId: body.profile ?? 'bot-one', text: body.text });
    if (!initial.runEscalated) throw new Error('Superagent evaluator cannot escalate');
    const task = { text: body.text, source: 'neo/app', ticketId: 'eval-probe' };
    return initial.runEscalated(task, async (binding, signal) => {
      const request = { role: 'user', content: [{ type: 'text', text: body.text }] };
      let result = '';
      for await (const chunk of binding.adapter.stream({ provider: binding.provider, model: binding.model,
        messages: [request], signal })) {
        if (chunk.type === 'block-end' && chunk.block.type === 'text') result += chunk.block.text;
      }
      if (JSON.parse(result).decision !== 'accept') throw new ModelRouteRejected('Superagent Eval declined the proposed ticket');
      return binding.model;
    }, async () => {});
  });
} };`);

let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
try {
  gateway = await startGateway({ databaseFile: join(home, 'gateway.db'), dataDir: home,
    extensionsDir, mode: 'desktop' });
  assert.ok(gateway.desktopToken);
  const rpc = createORPCClient<ContractRouterClient<typeof neoContract>>(new RPCLink({
    url: `http://127.0.0.1:${gateway.port}`,
    headers: { authorization: `Bearer ${gateway.desktopToken}` },
  }));
  assert.equal((await rpc.extensions.enable({ id: 'models' })).status, 'running');
  assert.equal((await rpc.extensions.enable({ id: 'probe' })).status, 'running');
  assert.equal((await rpc.extensions.enable({ id: 'models-router-panda' })).status, 'running');
  for (const role of MODEL_ROLES) {
    await rpc.x.models.providers.put({ id: role, kind: 'openai-compatible',
      baseUrl: `${endpoint}/${role}/v1`, apiKey: secret });
    await rpc.x.models.roles.set({ role, providerId: role, model: `direct-${role}` });
  }
  const roles = Object.fromEntries(MODEL_ROLES.map((role) => [role,
    [{ providerId: role, modelId: `panda-${role}`, model: `tier-${role}` }]]));
  const base = { endpoint, timeoutMs: 500, roles };
  const configure = (enabled: boolean, maxAttempts = 2, maxTotalMs = 30000) =>
    rpc.x['models-router-panda'].settings.set({ ...base,
      escalation: { enabled, maxAttempts, maxTotalMs } });
  const invoke = (route: string, body: Record<string, unknown>) =>
    gateway!.kernel.invokeRoute(`/x/probe/${route}`, 'RPC', body) as Promise<string>;
  await configure(true);
  const fast = await invoke('run', { role: 'fast', text: 'Research a safe public change', ticketId: 'fast-turn' });
  assert.equal(fast, 'tier-default');
  assert.deepEqual(calls.splice(0), ['tier-fast', 'tier-default']);
  assert.deepEqual(routed.slice(-2).map((item) => item.kind_hint), ['fast', 'default']);
  assert.ok(routed.every((item) => !item.text.includes(secret)));
  console.log('P2-9_ESCALATE PASS failed_turn=fast next_tier=default');

  const evalResult = await invoke('eval', { text: 'Review and decide this proposal' });
  assert.equal(evalResult, 'tier-reasoning');
  assert.deepEqual(calls.splice(0), ['tier-eval', 'tier-reasoning']);
  console.log('P2-9_EVAL PASS declined=eval accepted=reasoning');

  await configure(true, 1);
  await assert.rejects(invoke('run', { role: 'fast', text: 'One attempt only' }), /Model turn failed/);
  assert.deepEqual(calls.splice(0), ['tier-fast']);
  await configure(false);
  await assert.rejects(invoke('run', { role: 'fast', text: 'Kill switch' }), /Model turn failed/);
  assert.deepEqual(calls.splice(0), ['tier-fast']);
  console.log('P2-9_LIMITS PASS max_attempts=1 kill_switch=true');

  await configure(true, 2, 100);
  delayFast = true;
  await assert.rejects(invoke('run', { role: 'fast', text: 'Time budget' }));
  delayFast = false;
  assert.deepEqual(calls.splice(0), ['tier-fast']);
  console.log('P2-9_BUDGET PASS timeout=100ms no_second_call=true');

  await configure(true);
  await rpc.x.models.override.set({ profile: 'specific', providerId: 'fast', model: 'tier-fast' });
  await assert.rejects(invoke('run', { role: 'fast', profile: 'specific', text: 'Profile override' }));
  assert.deepEqual(calls.splice(0), ['tier-fast']);

  const traceFile = join(home, 'extensions', 'models-router-panda', 'traces', 'decisions.jsonl');
  const lines = (await readFile(traceFile, 'utf8')).trim().split('\n');
  const traces = lines.map((line) => JSON.parse(line));
  const first = traces.filter((row) => row.ticketId === 'fast-turn');
  assert.deepEqual(first.map((row) => [row.attempt, row.tier, row.outcome]),
    [[1, 'fast', 'failed'], [2, 'default', 'accepted']]);
  for (const row of traces) {
    for (const field of ['trace_id', 'ticketId', 'source', 'inputsSummary', 'candidates',
      'chosenAction', 'modelRole', 'model_id', 'choice', 'ranking', 'latencyMs', 'outcome', 'success',
      'actual_latency_ms', 'attempt', 'tier', 'at']) assert.ok(field in row, `Missing ${field}`);
  }
  assert.ok(!lines.join('').includes(secret));
  console.log('P2-9_TRACE PASS panda_fields=true per_attempt=true key_absent=true');

  assert.equal((await rpc.extensions.disable({ id: 'models-router-panda' })).status, 'disabled');
  const before = routed.length;
  assert.equal(await invoke('run', { role: 'fast', text: 'Direct fallback' }), 'direct-fast');
  assert.deepEqual(calls.splice(0), ['direct-fast']);
  assert.equal(routed.length, before);
  assert.equal((await rpc.extensions.list()).find((item) => item.id === 'models')?.status, 'running');
  console.log('P2-9_DISABLE PASS direct_fallback=true models_healthy=true');
} finally {
  await gateway?.close();
  fake.closeAllConnections();
  await new Promise<void>((done) => fake.close(() => done()));
  await rm(home, { recursive: true, force: true });
}
