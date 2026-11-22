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
  const denied=await bridge.ready('${engine}','denied-${engine}',home+'-denied',process.env.NMH_P212_WORKSPACE); await writeFile(join(home,'denied.json'),JSON.stringify(denied));
  const foreign=await bridge.ready('${engine}','foreign-${engine}',home+'-foreign','workspace-b'); await writeFile(join(home,'foreign.json'),JSON.stringify(foreign));
  ctx.effect(()=>async()=>{for(const profile of ['test-${engine}','denied-${engine}','foreign-${engine}'])await bridge.forget('${engine}',profile);}); ctx.health(()=>({ok:true}));
}};`);
let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
try {
  gateway = await startGateway({ databaseFile: join(home, 'db.sqlite'), dataDir: home, extensionsDir: sources, mode: 'desktop', appsHttpClient: fake.http });
  const base = `http://127.0.0.1:${gateway.port}`;
  const client = (token?: string) => createORPCClient<ContractRouterClient<typeof neoContract>>(new RPCLink({ url: base, headers: token ? { authorization: `Bearer ${token}` } : {} }));
  const owner = client(gateway.desktopToken!); assert.ok(gateway.desktopToken);
  const workspace = await gateway.auth.kysely.selectFrom('organization').select('id').executeTakeFirstOrThrow();
  process.env.NMH_P212_WORKSPACE = workspace.id;
  await gateway.auth.kysely.insertInto('organization').values({ id: 'workspace-b', name: 'Other workspace', slug: 'p212-other', createdAt: Date.now() }).execute();
  const roles = new Map<string, ReturnType<typeof client>>();
  for (const role of ['viewer', 'member', 'member-b', 'other-workspace']) {
    const signup = await gateway.auth.api.signUpEmail({ body: { name: role, email: `${role}@p212.test`, password: 'Fake-p212-password!234' } });
    if (role === 'other-workspace') await gateway.auth.kysely.insertInto('member').values({ id: 'member-other-workspace', organizationId: 'workspace-b', userId: signup.user.id, role: 'member', createdAt: Date.now() }).execute();
    else await gateway.auth.api.addMember({ body: { organizationId: workspace.id, userId: signup.user.id, role: role === 'viewer' ? 'viewer' : 'member' }, headers: new Headers({ authorization: `Bearer ${gateway.desktopToken}` }) });
    roles.set(role, client(signup.token!));
  }
  const viewer = roles.get('viewer')!; const member = roles.get('member')!;
  await assert.rejects(client().apps.toolkits({}), (e: any) => e.code === 'UNAUTHORIZED');
  for (const id of ['sample-ts','apps-composio','engine-superagent']) assert.equal((await owner.extensions.enable({ id })).status, 'running');
  await owner.settings.set({ extension: 'apps-composio', values: { endpoint: fake.endpoint, apiKey: 'fake-composio-only' } });
  const beforeOptIn = fake.calls.length;
  await assert.rejects(owner.apps.toolkits({})); assert.equal(fake.calls.length, beforeOptIn);
  await assert.rejects(member.settings.set({ extension: 'apps-composio', values: { allowPrivateNetwork: true } }));
  await owner.settings.set({ extension: 'apps-composio', values: { allowPrivateNetwork: true } });
  assert.deepEqual((await owner.settings.get({ extension: 'apps-composio' })).values.apiKey, { set: true });
  assert.equal((await viewer.apps.toolkits({}))[0]!.id, 'github');
  const connect = { toolkit: 'github', authConfigId: 'ac_test' };
  await assert.rejects(viewer.apps.connect(connect), (e: any) => e.code === 'FORBIDDEN');
  const account = await member.apps.connect({ ...connect, callbackUrl: 'https://attacker.test/' } as any); assert.match(account.redirectUrl, /^https:/);
  assert.equal(fake.calls.find(c => c.path.endsWith('/connected_accounts/link'))!.body.callback_url, base + '/');
  const request = { provider: 'composio', accountId: account.id, action: 'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER', arguments: { repo: 'test/repo' } };
  await assert.rejects(viewer.apps.run(request), (e: any) => e.code === 'FORBIDDEN');
  const accountB = await roles.get('other-workspace')!.apps.connect(connect);
  assert.notEqual(account.id, accountB.id);
  const beforeForeign = fake.calls.length;
  await assert.rejects(roles.get('member-b')!.apps.run(request), (e: any) => e.code === 'NOT_FOUND');
  await assert.rejects(roles.get('other-workspace')!.apps.run(request), (e: any) => e.code === 'NOT_FOUND');
  const requestB = { ...request, accountId: accountB.id };
  await assert.rejects(member.apps.run(requestB), (e: any) => e.code === 'NOT_FOUND');
  await assert.rejects(member.apps.grant({ provider: 'composio', accountId: accountB.id, engine: 'hermes', profile: 'test-hermes', enabled: true }), (e: any) => e.code === 'NOT_FOUND');
  await assert.rejects(roles.get('member-b')!.apps.grant({ provider: 'composio', accountId: account.id, engine: 'hermes', profile: 'test-hermes', enabled: true }), (e: any) => e.code === 'NOT_FOUND');
  assert.equal(fake.calls.length, beforeForeign, 'Cross-user/workspace requests never reach Composio');
  const executes = () => fake.calls.filter(c => c.path.includes('/execute/')).length;
  await owner.inbox.acceptMode.set({ mode: 'act' });
  assert.equal((await member.apps.run(request) as any).status, 'completed'); const count = executes();
  const destructive = { ...request, action: 'GITHUB_DELETE' };
  let pending = await member.apps.run(destructive) as any; assert.equal(pending.status, 'approval'); assert.equal(executes(), count);
  const item = (await owner.inbox.list()).find(i => i.id === pending.inboxId)!; assert.ok(!JSON.stringify(item).includes('test/repo')); assert.equal(item.appAction, undefined); assert.equal(item.source, 'neo/apps');
  const ownerItem = (await member.inbox.list()).find(i => i.id === pending.inboxId)!;
  assert.deepEqual(ownerItem.appAction!.arguments, request.arguments, 'Only the connected-account owner sees exact arguments');
  const viewerItem = (await viewer.inbox.list()).find(i => i.id === pending.inboxId)!;
  assert.ok(viewerItem.text.includes('details restricted')); assert.ok(!JSON.stringify(viewerItem).includes('test/repo')); assert.equal(viewerItem.appAction, undefined);
  const memberBItem = (await roles.get('member-b')!.inbox.list()).find(i => i.id === pending.inboxId)!;
  assert.ok(memberBItem.text.includes('details restricted'));
  assert.ok(!JSON.stringify(memberBItem).includes('test/repo') && !JSON.stringify(memberBItem).includes(account.id));
  assert.ok(!(await roles.get('other-workspace')!.inbox.list()).some(i => i.id === pending.inboxId));
  await assert.rejects(roles.get('other-workspace')!.inbox.accept({ id: pending.inboxId }));
  const viewerEvents = await viewer.inbox.events({ since: 0 }, { signal: AbortSignal.timeout(5000) });
  for await (const event of viewerEvents) if (event.item.id === pending.inboxId) { assert.ok(!JSON.stringify(event).includes('test/repo')); break; }
  const memberBEvents = await roles.get('member-b')!.inbox.events({ since: 0 }, { signal: AbortSignal.timeout(5000) });
  for await (const event of memberBEvents) if (event.item.id === pending.inboxId) {
    assert.ok(!JSON.stringify(event).includes('test/repo') && !JSON.stringify(event).includes(account.id)); break;
  }
  await assert.rejects(roles.get('member-b')!.inbox.approval.decide({ id: pending.inboxId, decision: 'approve', reason: 'foreign member' }), (e: any) => e.code === 'FORBIDDEN');
  await assert.rejects(roles.get('member-b')!.inbox.approval.decide({ id: pending.inboxId, decision: 'deny', reason: 'foreign member' }), (e: any) => e.code === 'FORBIDDEN');
  assert.equal(executes(), count, 'Another member cannot approve or reject a connected-account action');
  const adminFirst = await owner.inbox.approval.decide({ id: pending.inboxId, decision: 'approve', reason: 'Workspace admin review' });
  assert.equal(adminFirst.status, 'approval'); assert.equal(executes(), count, 'Admin cannot execute without account owner');
  await member.inbox.approval.decide({ id: pending.inboxId, decision: 'approve', reason: 'Reviewed my account request' }); assert.equal(executes(), count + 1);
  await assert.rejects(member.inbox.approval.decide({ id: pending.inboxId, decision: 'approve', reason: 'duplicate' })); assert.equal(executes(), count + 1);
  pending = await member.apps.run(destructive) as any;
  const ownerFirst = await member.inbox.approval.decide({ id: pending.inboxId, decision: 'approve', reason: 'Account owner review' });
  assert.equal(ownerFirst.status, 'approval'); assert.equal(executes(), count + 1, 'Member cannot self-approve destructive action');
  await owner.inbox.approval.decide({ id: pending.inboxId, decision: 'approve', reason: 'Workspace admin review' }); assert.equal(executes(), count + 2);
  pending = await member.apps.run(destructive) as any; await member.inbox.approval.decide({ id: pending.inboxId, decision: 'deny', reason: 'deny' }); assert.equal(executes(), count + 2);
  await owner.inbox.acceptMode.set({ mode: 'observe' }); pending = await member.apps.run(request) as any; assert.equal(pending.status, 'suggestion'); assert.equal(executes(), count + 2);
  await assert.rejects(roles.get('member-b')!.inbox.accept({ id: pending.inboxId }), (e: any) => e.code === 'FORBIDDEN');
  await member.inbox.accept({ id: pending.inboxId }); assert.equal(executes(), count + 3);
  await owner.inbox.acceptMode.set({ mode: 'act-with-approval' }); pending = await member.apps.run(request) as any; assert.equal(pending.status, 'approval'); await member.inbox.approval.decide({ id: pending.inboxId, decision: 'approve', reason: 'Approve read-only action' });
  const tokens: string[] = [];
  await owner.inbox.acceptMode.set({ mode: 'act' });
  for (const engine of ['hermes','dsh','superagent']) {
    await member.apps.grant({ provider: 'composio', accountId: account.id, engine: engine as any, profile: `test-${engine}`, enabled: true });
    assert.equal((await owner.extensions.enable({ id: `fake-${engine}` })).status, 'running');
    await assert.rejects(member.apps.grant({ provider: 'composio', accountId: account.id, engine: engine as any, profile: `foreign-${engine}`, enabled: true }), (e: any) => e.code === 'NOT_FOUND');
    const config = JSON.parse(await readFile(join(home, 'extensions', `fake-${engine}`, 'config.json'), 'utf8'));
    const binding = JSON.parse(await readFile(config.env.NEO_APPS_MCP_BINDING, 'utf8')); tokens.push(binding.token);
    assert.equal(binding.workspace, workspace.id);
    assert.equal(await gateway.vault.get({ kind: 'engine', workspaceId: workspace.id, subjectId: `engine-${engine}/test-${engine}` }, 'NEO_APPS_MCP_TOKEN'), binding.token);
    assert.equal(await gateway.vault.get({ kind: 'engine', workspaceId: 'workspace-b', subjectId: `engine-${engine}/test-${engine}` }, 'NEO_APPS_MCP_TOKEN'), undefined);
    assert.ok(!JSON.stringify(config).includes('fake-composio-only'));
    const mcp = new FakeMcpEngine(config); clients.push(mcp);
    const tools = await mcp.initialize(); assert.deepEqual(tools.tools.map((t: any) => t.name).sort(), ['connect','run','toolkits']);
    assert.equal(JSON.parse((await mcp.call('toolkits')).content[0].text).toolkits[0].id, 'github');
    assert.equal(JSON.parse((await mcp.call('run', request)).content[0].text).status, 'completed');
    const deniedConfig = JSON.parse(await readFile(join(home, 'extensions', `fake-${engine}`, 'denied.json'), 'utf8'));
    const deniedMcp = new FakeMcpEngine(deniedConfig); clients.push(deniedMcp); await deniedMcp.initialize();
    assert.ok((await deniedMcp.call('run', request)).isError, 'An ungranted profile cannot use another profile\'s account');
    const foreignConfig = JSON.parse(await readFile(join(home, 'extensions', `fake-${engine}`, 'foreign.json'), 'utf8'));
    const foreignMcp = new FakeMcpEngine(foreignConfig); clients.push(foreignMcp); await foreignMcp.initialize();
    assert.ok((await foreignMcp.call('run', request)).isError, 'A valid token in another workspace cannot use this account');
    assert.ok((await mcp.call('connect', { ...connect, provider: 'composio', callbackUrl: 'https://attacker.test' })).isError);
    await member.apps.grant({ provider: 'composio', accountId: account.id, engine: engine as any, profile: `test-${engine}`, enabled: false });
    assert.ok((await mcp.call('run', request)).isError, 'Grant revocation takes effect without restarting the engine');
    await member.apps.grant({ provider: 'composio', accountId: account.id, engine: engine as any, profile: `test-${engine}`, enabled: true });
    for (const scope of [{ profile: 'wrong', workspace: workspace.id }, { profile: `test-${engine}`, workspace: 'workspace-b' }]) assert.equal((await fetch(base + '/internal/apps-mcp/action', { method: 'POST', headers: { authorization: `Bearer ${binding.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ engine, ...scope, action: { operation: 'run', ...request } }) })).status, 403);
  }
  assert.equal(new Set(tokens).size, 3);
  assert.ok(!(await readFile(join(home, 'db.sqlite'))).includes(Buffer.from('fake-composio-only')));
  pending = await member.apps.run(destructive) as any;
  await owner.extensions.disable({ id: 'apps-composio' });
  for (const mcp of clients) assert.ok((await mcp.call('run', request)).isError);
  assert.equal((await member.inbox.approval.decide({ id: pending.inboxId, decision: 'approve', reason: 'Stale' })).status, 'approval');
  await assert.rejects(owner.inbox.approval.decide({ id: pending.inboxId, decision: 'approve', reason: 'Stale' }));
  for (const engine of ['hermes','dsh','superagent']) assert.equal((await owner.extensions.list()).find(e => e.id === `fake-${engine}`)!.status, 'running');
  assert.equal((await fetch(base + '/x/sample-ts/hello', { headers: { authorization: `Bearer ${gateway.desktopToken}` } })).status, 200);
  fake.setFail(true); await owner.extensions.enable({ id: 'apps-composio' }); await assert.rejects(owner.apps.toolkits({})); assert.equal((await owner.extensions.list()).find(e => e.id === 'apps-composio')!.health!.ok, true);
  console.log('P2-12 PASS desktop_auth=true fake_Composio_only=true owner_only_accounts=true App_and_MCP_workspace_isolation=true explicit_profile_grants=true revocation=true vault_scope_verified=true local_read_policy=true private_network_opt_in_admin=true Neo_callback_only=true cross_member_list_and_event_redaction=true account_owner_only_approval=true accept_modes=true destructive_admin_approval=true MCP_three_engines=true disable_isolation=true');
} finally { await Promise.all(clients.map(c => c.close())); await gateway?.close(); await fake.close(); await rm(home, { recursive: true, force: true, maxRetries: 5 }); }
