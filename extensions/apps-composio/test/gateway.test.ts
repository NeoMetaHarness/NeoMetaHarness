import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { startGateway } from '../../../apps/gateway/src/server.js';
import { FakeMcpEngine } from '../../computers-mcp/test/fake-engine.js';
import { fakeComposio } from './fake.js';
const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const home = await mkdtemp(join(tmpdir(), 'neo-p212-')); const sources = join(home, 'source'); await mkdir(sources);
const fake = await fakeComposio(); const clients: FakeMcpEngine[] = [];
process.env.NODE_ENV = 'test'; process.env.NMH_SUPERAGENT_TEST_ADAPTER = new URL('../../engine-superagent/test/scripted-models.ts', import.meta.url).href;
process.env.NMH_HERMES_HOME = join(home, 'hermes');
if (!process.env.NMH_UPSTREAM_CACHE) for (let root = repo; ; root = dirname(root)) { const candidate = join(root, 'nmh-upstream-cache'); try { if (!(await stat(candidate)).isDirectory()) throw Error(); process.env.NMH_UPSTREAM_CACHE = candidate; break; } catch {} if (dirname(root) === root) throw Error('Set NMH_UPSTREAM_CACHE'); }
async function extension(id: string, code: string, manifest?: any) {
  const dir = join(sources, id); await mkdir(dir); await writeFile(join(dir, 'neo.extension.json'), JSON.stringify({ ...(manifest ?? { id, version: '0.1.0', displayName: id, kind: ['tool'] }), runtime: { type: 'cordis', entry: './index.mjs' } })); await writeFile(join(dir, 'index.mjs'), code);
}
for (const id of ['apps-composio', 'engine-superagent', 'sample-ts']) {
  const source = join(repo, 'extensions', id); const manifest = JSON.parse(await readFile(join(source, 'neo.extension.json'), 'utf8'));
  await extension(id, `export { default } from ${JSON.stringify(pathToFileURL(join(source, 'src/index.ts')).href)};`, manifest);
}
for (const engine of ['hermes','dsh','superagent']) await extension(`fake-${engine}`, `import { mkdir,writeFile } from 'node:fs/promises'; import { join } from 'node:path'; export default { async activate(ctx) {
  const bridge=ctx.inject('appsMcpBridge'); const home=join(ctx.inject('extensionDataDir'),'fake-${engine}'); await mkdir(home,{recursive:true});
  const config=await bridge.ready('${engine}','test-${engine}',home); await writeFile(join(home,'config.json'),JSON.stringify(config));
  ctx.effect(()=>()=>bridge.forget('${engine}','test-${engine}')); ctx.health(()=>({ok:true}));
}};`);
let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
try {
  gateway = await startGateway({ databaseFile: join(home, 'db.sqlite'), dataDir: home, extensionsDir: sources, mode: 'desktop' });
  const base = `http://127.0.0.1:${gateway.port}`;
  const client = (token?: string) => createORPCClient<ContractRouterClient<typeof neoContract>>(new RPCLink({ url: base, headers: token ? { authorization: `Bearer ${token}` } : {} }));
  const owner = client(gateway.desktopToken!); assert.ok(gateway.desktopToken);
  const workspace = await gateway.auth.kysely.selectFrom('organization').select('id').executeTakeFirstOrThrow();
  const roles = new Map<string, ReturnType<typeof client>>();
  for (const role of ['viewer', 'member']) {
    const signup = await gateway.auth.api.signUpEmail({ body: { name: role, email: `${role}@p212.test`, password: 'Fake-p212-password!234' } });
    await gateway.auth.api.addMember({ body: { organizationId: workspace.id, userId: signup.user.id, role }, headers: new Headers({ authorization: `Bearer ${gateway.desktopToken}` }) });
    roles.set(role, client(signup.token!));
  }
  const viewer = roles.get('viewer')!; const member = roles.get('member')!;
  await assert.rejects(client().apps.toolkits({}), (e: any) => e.code === 'UNAUTHORIZED');
  for (const id of ['sample-ts','apps-composio','engine-superagent']) assert.equal((await owner.extensions.enable({ id })).status, 'running');
  await owner.settings.set({ extension: 'apps-composio', values: { endpoint: fake.endpoint, apiKey: 'fake-composio-only' } });
  assert.deepEqual((await owner.settings.get({ extension: 'apps-composio' })).values.apiKey, { set: true });
  assert.equal((await viewer.apps.toolkits({}))[0]!.id, 'github');
  const connect = { toolkit: 'github', authConfigId: 'ac_test', callbackUrl: 'http://127.0.0.1/oauth' };
  await assert.rejects(viewer.apps.connect(connect), (e: any) => e.code === 'FORBIDDEN');
  const account = await member.apps.connect(connect); assert.match(account.redirectUrl, /^https:/);
  const request = { provider: 'composio', accountId: account.id, action: 'GITHUB_LIST', arguments: { repo: 'test/repo' } };
  await assert.rejects(viewer.apps.run(request), (e: any) => e.code === 'FORBIDDEN');
  const executes = () => fake.calls.filter(c => c.path.includes('/execute/')).length;
  await owner.inbox.acceptMode.set({ mode: 'act' });
  assert.equal((await member.apps.run(request) as any).status, 'completed'); const count = executes();
  const destructive = { ...request, action: 'GITHUB_DELETE' };
  let pending = await member.apps.run(destructive) as any; assert.equal(pending.status, 'approval'); assert.equal(executes(), count);
  const item = (await owner.inbox.list()).find(i => i.id === pending.inboxId)!; assert.ok(item.text.includes('test/repo')); assert.equal(item.source, 'neo/apps');
  await assert.rejects(member.inbox.approval.decide({ id: pending.inboxId, decision: 'approve', reason: 'try' })); assert.equal(executes(), count);
  await owner.inbox.approval.decide({ id: pending.inboxId, decision: 'approve', reason: 'Reviewed exact request' }); assert.equal(executes(), count + 1);
  await assert.rejects(owner.inbox.approval.decide({ id: pending.inboxId, decision: 'approve', reason: 'duplicate' })); assert.equal(executes(), count + 1);
  pending = await member.apps.run(destructive) as any; await owner.inbox.approval.decide({ id: pending.inboxId, decision: 'deny', reason: 'deny' }); assert.equal(executes(), count + 1);
  await owner.inbox.acceptMode.set({ mode: 'observe' }); pending = await member.apps.run(request) as any; assert.equal(pending.status, 'suggestion'); assert.equal(executes(), count + 1); await member.inbox.accept({ id: pending.inboxId }); assert.equal(executes(), count + 2);
  await owner.inbox.acceptMode.set({ mode: 'act-with-approval' }); pending = await member.apps.run(request) as any; assert.equal(pending.status, 'approval'); await member.inbox.approval.decide({ id: pending.inboxId, decision: 'approve', reason: 'Approve read-only action' });
  const tokens: string[] = [];
  await owner.inbox.acceptMode.set({ mode: 'act' });
  for (const engine of ['hermes','dsh','superagent']) {
    assert.equal((await owner.extensions.enable({ id: `fake-${engine}` })).status, 'running');
    const config = JSON.parse(await readFile(join(home, 'extensions', `fake-${engine}`, 'config.json'), 'utf8'));
    const binding = JSON.parse(await readFile(config.env.NEO_APPS_MCP_BINDING, 'utf8')); tokens.push(binding.token);
    assert.ok(!JSON.stringify(config).includes('fake-composio-only'));
    const mcp = new FakeMcpEngine(config); clients.push(mcp);
    const tools = await mcp.initialize(); assert.deepEqual(tools.tools.map((t: any) => t.name).sort(), ['connect','run','toolkits']);
    assert.equal(JSON.parse((await mcp.call('toolkits')).content[0].text)[0].id, 'github');
    assert.equal(JSON.parse((await mcp.call('run', request)).content[0].text).status, 'completed');
    assert.equal((await fetch(base + '/internal/apps-mcp/action', { method: 'POST', headers: { authorization: `Bearer ${binding.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ engine, profile: 'wrong', action: { operation: 'run', ...request } }) })).status, 403);
  }
  assert.equal(new Set(tokens).size, 3);
  assert.ok(!(await readFile(join(home, 'db.sqlite'))).includes(Buffer.from('fake-composio-only')));
  pending = await member.apps.run(destructive) as any;
  await owner.extensions.disable({ id: 'apps-composio' });
  for (const mcp of clients) assert.ok((await mcp.call('run', request)).isError);
  await assert.rejects(owner.inbox.approval.decide({ id: pending.inboxId, decision: 'approve', reason: 'Stale' }));
  for (const engine of ['hermes','dsh','superagent']) assert.equal((await owner.extensions.list()).find(e => e.id === `fake-${engine}`)!.status, 'running');
  assert.equal((await fetch(base + '/x/sample-ts/hello', { headers: { authorization: `Bearer ${gateway.desktopToken}` } })).status, 200);
  fake.setFail(true); await owner.extensions.enable({ id: 'apps-composio' }); await assert.rejects(owner.apps.toolkits({})); assert.equal((await owner.extensions.list()).find(e => e.id === 'apps-composio')!.health!.ok, true);
  console.log('P2-12 PASS desktop_auth=true fake_Composio_only=true OAuth_link=true vault_key=true member_actions=true accept_modes=true destructive_admin_approval=true exactly_once_decision=true MCP_three_engines=true profile_tokens=true disable_isolation=true outage_healthy=true');
} finally { await Promise.all(clients.map(c => c.close())); await gateway?.close(); await fake.close(); await rm(home, { recursive: true, force: true, maxRetries: 5 }); }
