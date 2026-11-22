import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { startGateway } from '../../../apps/gateway/src/server.js';
import { FakeMcpEngine } from '../../computers-mcp/test/fake-engine.js';
import { fakeComposio } from './fake.js';

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const home = await mkdtemp(join(tmpdir(), 'neo-p212-server-'));
const sources = join(home, 'source');
await mkdir(sources);
const fake = await fakeComposio();
let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
let engine: FakeMcpEngine | undefined;
process.env.NODE_ENV = 'test';
process.env.NMH_SUPERAGENT_TEST_ADAPTER = new URL('../../engine-superagent/test/scripted-models.ts', import.meta.url).href;
process.env.NMH_HERMES_HOME = join(home, 'hermes');
if (!process.env.NMH_UPSTREAM_CACHE) {
  for (let root = repo; ; root = dirname(root)) {
    const candidate = join(root, 'nmh-upstream-cache');
    try {
      if (!(await stat(candidate)).isDirectory()) throw Error();
      process.env.NMH_UPSTREAM_CACHE = candidate;
      break;
    } catch { /* continue to ancestor */ }
    if (dirname(root) === root) throw Error('Set NMH_UPSTREAM_CACHE');
  }
}

async function fixture(id: string, source: string, manifest: unknown) {
  const dir = join(sources, id);
  await mkdir(dir);
  await writeFile(join(dir, 'neo.extension.json'), JSON.stringify(manifest));
  await writeFile(join(dir, 'index.mjs'), source);
}
for (const id of ['apps-composio', 'engine-superagent']) {
  const source = join(repo, 'extensions', id);
  const manifest = JSON.parse(await readFile(join(source, 'neo.extension.json'), 'utf8'));
  await fixture(id, `export { default } from ${JSON.stringify(pathToFileURL(join(source, 'src/index.ts')).href)};`, {
    ...manifest, runtime: { type: 'cordis', entry: './index.mjs' },
  });
}
await fixture('fake-hermes-b', `import { mkdir, writeFile } from 'node:fs/promises';
  import { join } from 'node:path';
  export default { async activate(ctx) {
    const bridge = ctx.inject('appsMcpBridge');
    const home = join(ctx.inject('extensionDataDir'), 'fake-hermes-b');
    await mkdir(home, { recursive: true });
    const config = await bridge.ready('hermes', 'server-profile-b', home, process.env.NMH_P212_WORKSPACE_B);
    await writeFile(join(home, 'config.json'), JSON.stringify(config));
    ctx.effect(() => () => bridge.forget('hermes', 'server-profile-b'));
    ctx.health(() => ({ ok: true }));
  }};`, { id: 'fake-hermes-b', version: '0.1.0', displayName: 'Fake Hermes B', kind: ['tool'], runtime: { type: 'cordis', entry: './index.mjs' } });

try {
  gateway = await startGateway({ databaseFile: join(home, 'db.sqlite'), dataDir: home,
    extensionsDir: sources, mode: 'server', signup: 'open', appsHttpClient: fake.http });
  const base = `http://127.0.0.1:${gateway.port}`;
  const post = (path: string, body: unknown, token?: string) => fetch(`${base}/auth/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const signup = async (name: string) => {
    const res = await post('sign-up/email', { name, email: `${name}@p212.test`, password: 'Test-password-1234!' });
    assert.equal(res.status, 200, `sign up ${name}`);
    return (await res.json() as { token: string }).token;
  };
  const createOrg = async (token: string, name: string) => {
    const res = await post('organization/create', { name, slug: `p212-${name}` }, token);
    assert.equal(res.status, 200, `create workspace ${name}`);
    return (await res.json() as { id: string }).id;
  };
  const client = (token: string) => createORPCClient<ContractRouterClient<typeof neoContract>>(
    new RPCLink({ url: base, headers: { authorization: `Bearer ${token}` } }));
  const founderToken = await signup('founder');
  const workspaceA = await createOrg(founderToken, 'a');
  const memberToken = await signup('member');
  const adminToken = await signup('admin');
  const workspaceBToken = await signup('workspace-b-owner');
  const workspaceB = await createOrg(founderToken, 'b');
  assert.equal((await post('organization/set-active', { organizationId: workspaceA }, founderToken)).status, 200);
  process.env.NMH_P212_WORKSPACE_B = workspaceB;
  const invitationB = await post('organization/invite-member', {
    organizationId: workspaceB, email: 'workspace-b-owner@p212.test', role: 'admin',
  }, founderToken);
  assert.equal(invitationB.status, 200);
  const { id: invitationBId } = await invitationB.json() as { id: string };
  assert.equal((await post('organization/accept-invitation', { invitationId: invitationBId }, workspaceBToken)).status, 200);
  assert.equal((await post('organization/set-active', { organizationId: workspaceB }, workspaceBToken)).status, 200);
  for (const [token, email, role] of [
    [memberToken, 'member@p212.test', 'member'],
    [adminToken, 'admin@p212.test', 'admin'],
  ] as const) {
    const invitation = await post('organization/invite-member', { organizationId: workspaceA, email, role }, founderToken);
    assert.equal(invitation.status, 200);
    const { id } = await invitation.json() as { id: string };
    assert.equal((await post('organization/accept-invitation', { invitationId: id }, token)).status, 200);
    assert.equal((await post('organization/set-active', { organizationId: workspaceA }, token)).status, 200);
  }
  const founder = client(founderToken);
  const member = client(memberToken);
  const admin = client(adminToken);
  const ownerB = client(workspaceBToken);

  for (const id of ['apps-composio', 'engine-superagent', 'fake-hermes-b']) {
    assert.equal((await founder.extensions.enable({ id })).status, 'running', id);
  }
  await founder.settings.set({ extension: 'apps-composio', values: {
    endpoint: fake.endpoint, apiKey: 'fake-composio-only', allowPrivateNetwork: true,
  } });
  await ownerB.settings.set({ extension: 'apps-composio', values: {
    endpoint: fake.endpoint, apiKey: 'fake-composio-second', allowPrivateNetwork: true,
  } });
  const connect = { toolkit: 'github', authConfigId: 'ac_test' };
  assert.equal((await member.settings.get({ extension: 'apps-composio' })).values.apiKey.set, true);
  const accountA = await member.apps.connect(connect);
  const accountB = await ownerB.apps.connect(connect);
  assert.ok(fake.calls.some(c => c.path.endsWith('/connected_accounts/link') && c.credential === 'A'));
  assert.ok(fake.calls.some(c => c.path.endsWith('/connected_accounts/link') && c.credential === 'B'));

  await founder.inbox.acceptMode.set({ mode: 'act' });
  const destructive = { provider: 'composio', accountId: accountA.id, action: 'GITHUB_DELETE', arguments: { repo: 'workspace-a/private' } };
  const pending = await member.apps.run(destructive) as any;
  assert.equal(pending.status, 'approval');
  const ownerItem = (await member.inbox.list()).find(item => item.id === pending.inboxId)!;
  assert.equal(ownerItem.workspace, workspaceA);
  assert.deepEqual(ownerItem.appAction?.arguments, destructive.arguments);
  const adminItem = (await admin.inbox.list()).find(item => item.id === pending.inboxId)!;
  assert.equal(adminItem.appAction, undefined, 'Admin cannot inspect account owner arguments');
  assert.ok(!(await ownerB.inbox.list()).some(item => item.id === pending.inboxId));
  const executions = () => fake.calls.filter(c => c.path.includes('/execute/'));
  const before = executions().length;
  await assert.rejects(ownerB.inbox.approval.decide({ id: pending.inboxId, decision: 'approve', reason: 'foreign workspace' }));
  const first = await member.inbox.approval.decide({ id: pending.inboxId, decision: 'approve', reason: 'Account owner approved' });
  assert.equal(first.status, 'approval');
  assert.equal(executions().length, before, 'Member cannot approve destructive action alone');
  const completed = await admin.inbox.approval.decide({ id: pending.inboxId, decision: 'approve', reason: 'Workspace admin approved' });
  assert.equal(completed.status, 'ready');
  assert.equal(executions().length, before + 1);
  assert.equal(executions().at(-1)?.credential, 'A');

  await ownerB.inbox.acceptMode.set({ mode: 'act' });
  await ownerB.apps.grant({ provider: 'composio', accountId: accountB.id, engine: 'hermes', profile: 'server-profile-b', enabled: true });
  const config = JSON.parse(await readFile(join(home, 'extensions', 'fake-hermes-b', 'config.json'), 'utf8'));
  engine = new FakeMcpEngine(config);
  await engine.initialize();
  const requestB = { provider: 'composio', accountId: accountB.id,
    action: 'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER', arguments: {} };
  const response = await engine.call('run', requestB);
  assert.ok(!response.isError, JSON.stringify(response));
  assert.equal(JSON.parse(response.content[0].text).status, 'completed');
  assert.equal(executions().at(-1)?.credential, 'B', 'MCP execution must use granted workspace credentials');
  assert.ok((await engine.call('run', { ...requestB, accountId: accountA.id })).isError,
    'The B profile cannot reach A account or credentials');
  assert.equal(executions().at(-1)?.credential, 'B');
  console.log('P2-12_SERVER PASS server_inbox_visibility=true destructive_owner_and_admin=true account_redaction=true workspace_mcp_credentials=true');
} finally {
  await engine?.close();
  await gateway?.close();
  await fake.close();
  await rm(home, { recursive: true, force: true, maxRetries: 5 });
}
