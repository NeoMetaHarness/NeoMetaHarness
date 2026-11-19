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
import { authorize } from '../../../apps/gateway/src/policy.js';
import { MODEL_ROLES } from '../../models/src/hub.js';
const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const home = await mkdtemp(join(tmpdir(), 'neo-panda-gateway-'));
const routerSecret = 'TEST_ONLY_ROUTER_KEY_789';
const modelSecret = 'TEST_ONLY_MODEL_KEY_456';
let mode = 'ok'; let routes = 0; let directCalls = 0; let routedCalls = 0;
const fake = createServer(async (req, res) => {
  if (req.url === '/health') { assert.equal(req.headers.authorization, `Bearer ${routerSecret}`); res.end('{"ok":true}'); return; }
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  res.setHeader('content-type', 'application/json');
  if (req.url === '/route') {
    assert.equal(req.headers.authorization, `Bearer ${routerSecret}`); routes++;
    if (mode === 'offline') { res.writeHead(503).end(routerSecret); return; }
    res.end(JSON.stringify({ choice: { model_id: mode === 'unknown' ? 'not-in-pool' : body.pool[0] } })); return;
  }
  if (req.url?.endsWith('/chat/completions')) {
    assert.equal(req.headers.authorization, `Bearer ${modelSecret}`);
    const routed = req.url.startsWith('/routed/');
    routed ? routedCalls++ : directCalls++;
    res.end(JSON.stringify({ choices: [{ message: { content: `${routed ? 'routed' : 'direct'}:${body.model}` } }] })); return;
  }
  res.writeHead(404).end();
});
await new Promise<void>((done) => fake.listen(0, '127.0.0.1', done));
const address = fake.address(); assert.ok(address && typeof address !== 'string');
const endpoint = `http://127.0.0.1:${address.port}`;
const extensionsDir = join(home, 'extensions-source'); await mkdir(extensionsDir);
for (const id of ['models', 'models-router-panda']) {
  const source = join(repo, 'extensions', id);
  const manifest = JSON.parse(await readFile(join(source, 'neo.extension.json'), 'utf8'));
  manifest.runtime.entry = './index.mjs';
  await mkdir(join(extensionsDir, id));
  await writeFile(join(extensionsDir, id, 'neo.extension.json'), JSON.stringify(manifest));
  await writeFile(join(extensionsDir, id, 'index.mjs'), `export { default } from ${JSON.stringify(pathToFileURL(join(source, 'src', 'index.ts')).href)};`);
}
// Test-only consumer exercises the same injected Model Hub seam as engines, without any engine/subscription.
await mkdir(join(extensionsDir, 'probe'));
await writeFile(join(extensionsDir, 'probe', 'neo.extension.json'), JSON.stringify({
  id: 'probe', version: '0.1.0', displayName: 'Test consumer', kind: ['tool'],
  runtime: { type: 'cordis', entry: './index.mjs' }, dependsOn: { models: '*' },
}));
await writeFile(join(extensionsDir, 'probe', 'index.mjs'), `export default { activate(ctx) {
  const hub = ctx.inject('modelHub');
  ctx.route('run', async ({ body }) => {
    const binding = await hub.resolve(body.role, body.profile);
    const response = await fetch(binding.baseUrl + '/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + binding.apiKey },
      body: JSON.stringify({ model: binding.model, messages: [{role:'user', content:'fake task'}] })
    });
    return response.json();
  });
} };`);
const options = { databaseFile: join(home, 'gateway.db'), dataDir: home, extensionsDir, mode: 'desktop' as const };
let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
function client(token?: string) {
  return createORPCClient<ContractRouterClient<typeof neoContract>>(new RPCLink({
    url: `http://127.0.0.1:${gateway!.port}`, headers: token ? { authorization: `Bearer ${token}` } : {},
  }));
}
async function run(role: string, profile?: string): Promise<string> {
  const result = await gateway!.kernel.invokeRoute('/x/probe/run', 'RPC', { role, profile }) as { choices: { message: { content: string } }[] };
  return result.choices[0].message.content;
}
try {
  gateway = await startGateway(options);
  assert.ok(gateway.desktopToken);
  let rpc = client(gateway.desktopToken);
  await assert.rejects(client().x['models-router-panda'].settings.get(), (e: any) => e.code === 'UNAUTHORIZED');
  assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/x/models-router-panda/health`)).status, 401);
  await assert.rejects(rpc.x['models-router-panda'].health(), (e: any) => e.code === 'NOT_FOUND');
  assert.equal((await rpc.extensions.enable({ id: 'models' })).status, 'running');
  assert.equal((await rpc.extensions.enable({ id: 'probe' })).status, 'running');
  assert.equal((await rpc.extensions.enable({ id: 'models-router-panda' })).status, 'running');
  const panda = rpc.x['models-router-panda'];
  assert.equal(await panda.settings.get(), null);
  await rpc.vault.put({ scope: { kind: 'workspace', workspaceId: 'default' }, name: 'PANDA_API_KEY', value: routerSecret });
  for (const id of ['direct', 'routed']) await rpc.x.models.providers.put({ id, kind: 'openai-compatible', baseUrl: `${endpoint}/${id}/v1`, apiKey: modelSecret });
  for (const role of MODEL_ROLES) await rpc.x.models.roles.set({ role, providerId: 'direct', model: `direct-${role}` });
  const settings = { endpoint, vaultSecret: 'PANDA_API_KEY', timeoutMs: 500,
    roles: Object.fromEntries(MODEL_ROLES.map((role) => [role, [{ modelId: `card-${role}`, providerId: 'routed', model: `routed-${role}` }]])) };
  assert.deepEqual(await panda.settings.set(settings), settings);
  assert.deepEqual(await panda.health(), { ok: true, configured: true });
  for (const role of MODEL_ROLES) assert.equal(await run(role), `routed:routed-${role}`);
  assert.equal(routedCalls, 5);
  await rpc.x.models.override.set({ profile: 'explicit', providerId: 'direct', model: 'override' });
  const before = routes;
  assert.equal(await run('coding', 'explicit'), 'direct:override'); assert.equal(routes, before);
  for (mode of ['offline', 'unknown']) assert.equal(await run('coding'), 'direct:direct-coding');
  assert.equal((await rpc.extensions.list()).find((item) => item.id === 'models')?.status, 'running');
  assert.equal((await rpc.extensions.disable({ id: 'models-router-panda' })).status, 'disabled');
  const disabledCount = routes;
  assert.equal(await run('coding'), 'direct:direct-coding'); assert.equal(routes, disabledCount);
  await assert.rejects(panda.settings.get(), (e: any) => e.code === 'NOT_FOUND');
  // Authorization remains enforced while the extension is disabled.
  await assert.rejects(client().x['models-router-panda'].settings.get(), (e: any) => e.code === 'UNAUTHORIZED');
  mode = 'ok';
  assert.equal((await rpc.extensions.enable({ id: 'models-router-panda' })).status, 'running');
  assert.equal(await run('coding'), 'routed:routed-coding');
  const disk = await readFile(join(home, 'extensions', 'models-router-panda', 'settings.json'), 'utf8');
  assert.ok(!disk.includes(routerSecret) && !disk.includes(modelSecret));
  assert.ok(!(await readFile(options.databaseFile)).includes(Buffer.from(routerSecret)));
  await gateway.close(); gateway = await startGateway(options); rpc = client(gateway.desktopToken);
  assert.deepEqual(await rpc.x['models-router-panda'].settings.get(), settings);
  assert.equal(await run('fast'), 'routed:routed-fast');
  const context = { user: { id: 'viewer' }, role: 'viewer', workspaceId: 'default' };
  for (const path of ['x.models-router-panda.settings.get', 'x.models-router-panda.settings.set']) {
    assert.throws(() => authorize(path, context as any), (e: any) => e.code === 'FORBIDDEN');
  }
  assert.ok(directCalls >= 4);
  console.log('PASS P2-8 authenticated Gateway: five-role Panda routing, vault key, real fake-provider calls, direct fallback, overrides, policy and disable/restart isolation');
} finally {
  await gateway?.close(); fake.closeAllConnections(); await new Promise<void>((done) => fake.close(() => done()));
  await rm(home, { recursive: true, force: true });
}
