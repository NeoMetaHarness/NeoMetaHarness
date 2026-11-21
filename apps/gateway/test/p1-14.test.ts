import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { extensionIntegrity } from '@neometaharness/kernel';
import { unsealFixtureTree } from '../../../packages/kernel/test/upgrade-fixtures.js';
import { getContractProcedurePaths } from '../src/policy.js';
import { startGateway } from '../src/server.js';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const org = (name: string) => ({ name, slug: name.toLowerCase(), keepCurrentActiveOrganization: true });
const forbidden = (error: unknown) => (error as { code?: string })?.code === 'FORBIDDEN';
const notFound = (error: unknown) => (error as { code?: string })?.code === 'NOT_FOUND';
const backupInput = { out: 'fixture.neo', passphrase: 'fixture-passphrase' };
const restoreInput = { archive: 'fixture.neo', dataDir: 'fixture-destination', passphrase: 'fixture-passphrase' };

async function prepareFixture(mode: 'server' | 'desktop', withDeploymentRoutes = false) {
  const home = await mkdtemp(join(tmpdir(), 'neo-p114-'));
  const extensionsDir = join(home, 'bundled');
  const dataDir = join(home, 'data');
  const id = 'engine-superagent';
  const candidate = join(home, 'candidate');
  async function writeExtension(dir: string, version: string) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'neo.extension.json'), JSON.stringify({
      id, version, displayName: 'Scripted Inbox',
      runtime: { type: 'cordis', entry: 'index.mjs' },
    }));
    await writeFile(join(dir, 'index.mjs'), `export default { activate(ctx) {
      const items = [{
        id: 'binding', source: 'neo/binding', text: 'Hermes binding fixture',
        botId: 'fake', mode: 'observe', status: 'suggestion', createdAt: 1, updatedAt: 1,
      }, {
        id: 'private-message', source: 'neo/channel', text: 'Private conversation from workspace B',
        botId: 'fake', mode: 'observe', status: 'suggestion', createdAt: 2, updatedAt: 2,
      }];
      const notice = (id, source) => ({ ...items[0], id, source, destructive: true });
      if (${withDeploymentRoutes}) {
        items.push(notice('upstream', 'neo/upstream'), notice('github', 'neo/github'));
        ctx.route('ask', ({ body }) => {
          const item = { ...items[0], ...body, id: 'ask-' + items.length, source: 'neo/app' };
          items.push(item);
          return item;
        });
        const modes = new Map();
        ctx.route('accept-mode/get', ({ body }) => ({ mode: modes.get(body.workspace) ?? 'observe' }));
        ctx.route('accept-mode/set', ({ body }) => {
          modes.set(body.workspace, body.mode);
          return { mode: body.mode };
        });
        for (const [path, result] of Object.entries({
          'github/configure': { ok: true },
          'github/status': { repositories: [], mode: 'observe', hasToken: false, pausedUntil: null, stopped: false },
          'github/poll': { checked: 2, created: 1, pausedUntil: null },
          'github/pull-request': null,
          'upstream/check': { checked: 2, drift: 1 },
          'upstream/configure': { ok: true },
          'upstream/status': { botId: null, lastCheckedAt: null, lastDrift: null, lastError: null },
          'cron/list': [{ id: 'system-upstream', botId: 'neo-system', text: '@neo/upstream check', schedule: 'weekly', mode: 'observe' }],
          'cron/delete': { deleted: true },
        })) ctx.route(path, () => result);
        for (const path of ['accept', 'dismiss', 'approval/decide', 'reply', 'retry']) {
          ctx.route(path, ({ body }) => ({ ...items.find(item => item.id === body.id), text: path + ':' + (body.role ?? '') }));
        }
      }
      ctx.route('list', () => items);
    } };`);
  }
  await writeExtension(join(extensionsDir, id), '1.0.0');
  await writeExtension(candidate, '2.0.0');
  const backupDir = join(extensionsDir, 'backup');
  await mkdir(backupDir, { recursive: true });
  await writeFile(join(backupDir, 'neo.extension.json'), JSON.stringify({
    id: 'backup', version: '1.0.0', displayName: 'Scripted backup',
    runtime: { type: 'cordis', entry: 'index.mjs' },
  }));
  await writeFile(join(backupDir, 'index.mjs'), `export default { activate(ctx) {
    ctx.route('backup', ({ body }) => ({ out: body?.out ?? 'fixture.neo', files: 2, format: 1 }));
    ctx.route('restore', ({ body }) => ({ dataDir: body?.dataDir ?? 'fixture-destination', databaseFile: 'fixture.db', files: 2, format: 1 }));
  } };`);
  if (withDeploymentRoutes) {
    const scripted = {
      channels: {
        'list': { platforms: [] }, 'status': { platforms: [] },
        'connect': { connected: true }, 'disconnect': { disconnected: true },
        'senders': { senders: [] }, 'allow': { senders: [] }, 'revoke': { senders: [] },
        'approve': { senderId: '15550123456', role: 'member' },
        'notification/resolve': { channelId: 'scripted-notification' },
      },
      'engine-hermes': {
        'profiles/list': { profiles: [{ name: 'scripted', path: '/fixture' }] },
        'runs/start': { run_id: 'scripted-run' }, 'cron/list': [],
        'cron/update': { id: 'scripted-job' }, 'kanban/create-board': { slug: 'scripted-board' },
        'skills/list': [{ name: 'scripted-skill' }], 'kanban/boards': { boards: [], current: 'scripted' },
      },
      'skills-registry': {
        'list': [], 'ceiling': { ceiling: 'suggest' }, 'ceiling/get': { ceiling: 'suggest' }, 'ceiling/set': { ceiling: 'auto-low' },
        'evaluate': { status: 'passed', version: 1 },
      },
    };
    for (const [extensionId, routes] of Object.entries(scripted)) {
      const dir = join(extensionsDir, extensionId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'neo.extension.json'), JSON.stringify({
        id: extensionId, version: '1.0.0', displayName: extensionId, runtime: { type: 'cordis', entry: 'index.mjs' },
      }));
      await writeFile(join(dir, 'index.mjs'), `export default { activate(ctx) {
        for (const [path, result] of Object.entries(${JSON.stringify(routes)})) ctx.route(path, () => result);
      } };`);
    }
  }
  const upgrade = { id, directory: candidate, integrity: await extensionIntegrity(candidate) };
  const options = {
    databaseFile: join(dataDir, 'gateway.db'), dataDir, extensionsDir, mode,
    signup: 'open' as const, secret: 'local-p1-14-test-fixture-secret-long-enough',
  };
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  async function start() {
    gateway = await startGateway(options);
    return gateway;
  }
  async function stop() {
    await gateway?.close();
    gateway = undefined;
  }
  async function cleanup() {
    await stop();
    await unsealFixtureTree(join(dataDir, 'extensions', 'generations'));
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
  const base = () => `http://127.0.0.1:${gateway!.port}`;
  const raw = (path: string, token: string, input?: unknown) => fetch(base() + path, input === undefined
    ? { headers: bearer(token) }
    : { method: 'POST', headers: { ...bearer(token), 'content-type': 'application/json' }, body: JSON.stringify({ json: input }) });
  const client = (token: string) => createORPCClient<ContractRouterClient<typeof neoContract>>(
    new RPCLink({ url: base(), headers: bearer(token) }),
  );
  const authPost = (path: string, input: unknown, token?: string) => fetch(`${base()}/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? bearer(token) : {}) },
    body: JSON.stringify(input),
  });
  async function signup(email: string) {
    const response = await authPost('sign-up/email', { email, name: email, password: 'Test-fixture-only-123!' });
    assert.equal(response.status, 200);
    return await response.json() as { token: string; user: { id: string } };
  }
  function createOrg(name: string, token: string) {
    return authPost('organization/create', org(name), token);
  }
  return { id, upgrade, start, stop, cleanup, client, raw, signup, createOrg, authPost };
}

test('P1-14 server: first identity owns the deployment, and transfer survives restart', async () => {
  const fixture = await prepareFixture('server');
  try {
    const gateway = await fixture.start();
    const founder = await fixture.signup('founder@deployment.test');
    const other = await fixture.signup('owner@workspace-b.test');
    assert.equal((await fixture.createOrg('TooEarly', other.token)).status, 403);
    const createdA = await fixture.createOrg('WorkspaceA', founder.token);
    assert.equal(createdA.status, 200);
    const workspaceA = await createdA.json() as { id: string };
    const created = await fixture.createOrg('WorkspaceB', founder.token);
    assert.equal(created.status, 200);
    const workspace = await created.json() as { id: string };
    await gateway.auth.api.addMember({
      body: { organizationId: workspace.id, userId: other.user.id, role: 'owner' },
      headers: new Headers(bearer(founder.token)),
    });
    const deployment = fixture.client(founder.token);
    const workspaceOwner = fixture.client(other.token);
    assert.equal((await deployment.extensions.enable({ id: fixture.id })).status, 'running');
    assert.equal((await fixture.createOrg('Forbidden', other.token)).status, 403);
    assert.deepEqual(await workspaceOwner.inbox.list(), []);
    assert.deepEqual((await deployment.inbox.list()).map(item => item.id), ['binding']);
    await assert.rejects(deployment.inbox.accept({ id: 'private-message' }), notFound);
    console.log('P1-14_INBOX PASS binding notice visible; unstamped conversation hidden and unreachable');

    await assert.rejects(workspaceOwner.system.backup(backupInput), forbidden);
    await assert.rejects(workspaceOwner.system.restore(restoreInput), forbidden);
    await assert.rejects(deployment.system.backup(backupInput), notFound);
    await assert.rejects(deployment.system.restore(restoreInput), notFound);
    for (const route of ['/x/backup/backup', '/x/backup/restore']) {
      assert.equal((await fixture.raw(route, other.token)).status, 403);
      assert.equal((await fixture.raw(route, founder.token)).status, 404);
    }
    assert.equal((await deployment.extensions.enable({ id: 'backup' })).status, 'running');
    await assert.rejects(workspaceOwner.system.backup(backupInput), forbidden);
    await assert.rejects(workspaceOwner.system.restore(restoreInput), forbidden);
    assert.equal((await deployment.system.backup(backupInput)).files, 2);
    assert.equal((await deployment.system.restore(restoreInput)).files, 2);
    for (const route of ['/x/backup/backup', '/x/backup/restore']) {
      assert.equal((await fixture.raw(route, other.token)).status, 403);
      assert.equal((await fixture.raw(route, founder.token)).status, 200);
    }
    console.log('P1-14_BACKUP PASS owner checked before availability; RPC and raw routes restricted');
    await assert.rejects(workspaceOwner.system.transferDeploymentOwner({ userId: other.user.id }), forbidden);
    await assert.rejects(workspaceOwner.extensions.upgrade({ ...fixture.upgrade, id: 'absent-extension' }), forbidden);
    await assert.rejects(workspaceOwner.extensions.upgrade(fixture.upgrade), forbidden);
    assert.equal((await deployment.extensions.upgrade(fixture.upgrade)).upgraded, true);
    await assert.rejects(workspaceOwner.extensions.uninstall({ id: fixture.id }), forbidden);
    const instanceScopes = [
      { kind: 'workspace' as const, workspaceId: 'default' },
      { kind: 'engine' as const, workspaceId: 'fixture-tenant', subjectId: 'fixture-engine' },
    ];
    for (const scope of instanceScopes) {
      await deployment.vault.put({ scope, name: 'FIXTURE_KEY', value: 'fixture-value' });
      await assert.rejects(workspaceOwner.vault.list({ scope }), forbidden);
    }
    await assert.rejects(deployment.system.transferDeploymentOwner({ userId: 'absent-user' }),
      (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND');
    assert.deepEqual(await deployment.system.transferDeploymentOwner({ userId: other.user.id }), { userId: other.user.id });
    await assert.rejects(deployment.extensions.uninstall({ id: fixture.id }), forbidden);
    await assert.rejects(deployment.system.backup(backupInput), forbidden);
    await assert.rejects(deployment.system.restore(restoreInput), forbidden);
    for (const scope of instanceScopes) {
      await assert.rejects(deployment.vault.list({ scope }), forbidden);
      await assert.rejects(deployment.vault.put({ scope, name: 'FIXTURE_KEY', value: 'blocked-fixture-value' }), forbidden);
      await assert.rejects(deployment.vault.rotate({ scope, name: 'FIXTURE_KEY', value: 'blocked-fixture-value' }), forbidden);
      await assert.rejects(deployment.vault.delete({ scope, name: 'FIXTURE_KEY' }), forbidden);
      assert.equal((await workspaceOwner.vault.list({ scope })).length, 1);
      assert.equal((await workspaceOwner.vault.rotate({ scope, name: 'FIXTURE_KEY', value: 'updated-fixture-value' })).version, 2);
    }
    await assert.rejects(workspaceOwner.vault.list({ scope: { kind: 'workspace', workspaceId: workspaceA.id } }), forbidden);
    console.log('P1-14_VAULT PASS transfer revokes old owner and grants new owner instance access');

    await fixture.stop();
    await fixture.start();
    assert.equal((await fixture.createOrg('FormerOwner', founder.token)).status, 403);
    assert.equal((await fixture.createOrg('NewOwner', other.token)).status, 200);
    assert.deepEqual(await fixture.client(founder.token).inbox.list(), []);
    const newOwner = fixture.client(other.token);
    assert.deepEqual((await newOwner.inbox.list()).map(item => item.id), ['binding']);
    assert.equal((await newOwner.system.backup(backupInput)).files, 2);
    assert.equal((await newOwner.system.restore(restoreInput)).files, 2);
    for (const scope of instanceScopes) {
      await assert.rejects(fixture.client(founder.token).vault.list({ scope }), forbidden);
      assert.deepEqual(await newOwner.vault.delete({ scope, name: 'FIXTURE_KEY' }), { deleted: true });
    }
    assert.equal((await newOwner.extensions.uninstall({ id: fixture.id })).version, '1.0.0');
    console.log('P1-14_SERVER PASS org ownership is scoped; deployment transfer persisted across restart');
  } finally { await fixture.cleanup(); }
});

test('P1-14 desktop: the bootstrapped owner keeps Inbox and kernel access', async () => {
  const fixture = await prepareFixture('desktop');
  try {
    const gateway = await fixture.start();
    assert.ok(gateway.desktopToken);
    const client = fixture.client(gateway.desktopToken);
    assert.equal((await fixture.createOrg('DesktopWorkspace', gateway.desktopToken)).status, 200);
    assert.equal((await client.extensions.enable({ id: fixture.id })).status, 'running');
    assert.deepEqual((await client.inbox.list()).map(item => item.id), ['binding', 'private-message']);
    assert.equal((await client.extensions.enable({ id: 'backup' })).status, 'running');
    assert.equal((await client.system.backup(backupInput)).files, 2);
    assert.equal((await client.system.restore(restoreInput)).files, 2);
    assert.equal((await client.extensions.upgrade(fixture.upgrade)).upgraded, true);
    await assert.rejects(client.system.transferDeploymentOwner({ userId: 'absent-user' }),
      (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND');
    assert.equal((await client.extensions.uninstall({ id: fixture.id })).version, '1.0.0');
    console.log('P1-14_DESKTOP PASS bootstrap, Inbox, and extension lifecycle remain available');
  } finally { await fixture.cleanup(); }
});

test('P1-14 server: deployment routes work with a workspace viewer role', async () => {
  const fixture = await prepareFixture('server', true);
  try {
    const gateway = await fixture.start();
    const founder = await fixture.signup('founder@routes.test');
    const admin = await fixture.signup('admin@routes.test');
    const owner = await fixture.signup('viewer@routes.test');
    const response = await fixture.createOrg('WorkspaceRoutes', founder.token);
    assert.equal(response.status, 200);
    const workspace = await response.json() as { id: string };
    for (const [user, role] of [[admin, 'admin'], [owner, 'viewer']] as const) {
      await gateway.auth.api.addMember({
        body: { organizationId: workspace.id, userId: user.user.id, role },
        headers: new Headers(bearer(founder.token)),
      });
      assert.equal((await fixture.authPost('organization/set-active', { organizationId: workspace.id }, user.token)).status, 200);
    }
    const setup = fixture.client(founder.token);
    const workspaceAdmin = fixture.client(admin.token);
    const deployment = fixture.client(owner.token);
    await setup.system.transferDeploymentOwner({ userId: owner.user.id });

    const notify = { profile: 'scripted', senderId: '15550123456' };
    const ask = { botId: 'fake', text: 'Fixture request' };
    const deniedRoutes = [
      ...getContractProcedurePaths(neoContract.x.channels, 'x.channels'),
      ...getContractProcedurePaths(neoContract.x['engine-hermes'], 'x.engine-hermes'),
      ...getContractProcedurePaths(neoContract.inbox.github, 'inbox.github'),
      ...getContractProcedurePaths(neoContract.inbox.upstream, 'inbox.upstream'),
      ...['evaluate', 'override', 'import', 'sync', 'rollback', 'assign', 'checks.set', 'autonomy.set',
        'ceiling.set', 'hub.scan', 'hub.approve', 'hub.install'].map((path) => 'x.skills-registry.' + path),
    ];
    for (const route of deniedRoutes) {
      assert.equal((await fixture.raw('/' + route.replaceAll('.', '/'), admin.token, {})).status, 403, route);
    }
    await assert.rejects(deployment.x['engine-hermes'].profiles.list(), notFound);
    await assert.rejects(workspaceAdmin.inbox.ask({ ...ask, notify }), forbidden);
    await assert.rejects(deployment.inbox.ask({ ...ask, notify }), notFound);

    for (const id of [fixture.id, 'channels', 'engine-hermes', 'skills-registry']) {
      assert.equal((await setup.extensions.enable({ id })).status, 'running');
    }

    const channels = deployment.x.channels;
    const whatsapp = { profile: notify.profile, platform: 'whatsapp' } as const;
    assert.deepEqual(await channels.list(notify), { platforms: [] });
    assert.deepEqual(await channels.status(notify), { platforms: [] });
    assert.deepEqual(await channels.connect({ ...whatsapp, botId: ask.botId }), { connected: true });
    assert.deepEqual(await channels.disconnect(whatsapp), { disconnected: true });
    assert.deepEqual(await channels.senders(whatsapp), { senders: [] });
    assert.deepEqual(await channels.allow({ ...notify, ...whatsapp, role: 'member' }), { senders: [] });
    assert.deepEqual(await channels.revoke({ ...notify, ...whatsapp }), { senders: [] });
    assert.deepEqual(await channels.approve({ ...whatsapp, code: 'ABCDEF23', role: 'member' }),
      { senderId: notify.senderId, role: 'member' });
    assert.deepEqual(await channels.notification.resolve({ ...notify, botId: ask.botId }), { channelId: 'scripted-notification' });
    await assert.rejects(workspaceAdmin.x.channels.list(notify), forbidden);
    await assert.rejects(workspaceAdmin.inbox.ask({ ...ask, notify }), forbidden);
    const ordinaryItem = await deployment.inbox.ask({ ...ask, notify });
    assert.equal(ordinaryItem.workspace, workspace.id);
    assert.equal(ordinaryItem.notification?.channelId, 'scripted-notification');
    assert.equal((await workspaceAdmin.inbox.ask(ask)).workspace, workspace.id);
    await assert.rejects(deployment.inbox.dismiss({ id: ordinaryItem.id }), forbidden);
    assert.equal((await workspaceAdmin.inbox.dismiss({ id: ordinaryItem.id })).text, 'dismiss:admin');
    assert.deepEqual(await workspaceAdmin.inbox.acceptMode.set({ mode: 'act-with-approval' }), { mode: 'act-with-approval' });
    assert.deepEqual(await deployment.inbox.acceptMode.get(), { mode: 'act-with-approval' });
    await assert.rejects(deployment.inbox.acceptMode.set({ mode: 'observe' }), forbidden);

    const hermes = deployment.x['engine-hermes'];
    assert.equal((await hermes.profiles.list()).profiles[0]?.name, 'scripted');
    assert.deepEqual(await hermes.runs.start({ profile: notify.profile, input: 'fixture' }), { run_id: 'scripted-run' });
    assert.deepEqual(await hermes.cron.list({}), []);
    assert.deepEqual(await hermes.cron.update({ id: 'scripted-job', name: 'fixture' }), { id: 'scripted-job' });
    assert.deepEqual(await hermes.kanban.createBoard({ slug: 'scripted-board' }), { slug: 'scripted-board' });
    assert.deepEqual(await hermes.skills.list(notify), [{ name: 'scripted-skill' }]);
    assert.equal((await hermes.kanban.boards()).current, 'scripted');
    const skills = deployment.x['skills-registry'];
    assert.deepEqual(await skills.evaluate({ name: 'scripted/skill' }), { status: 'passed', version: 1 });
    assert.deepEqual(await skills.ceiling.set({ engine: 'hermes', targetId: 'scripted', ceiling: 'auto-low' }), { ceiling: 'auto-low' });
    assert.deepEqual(await workspaceAdmin.x['skills-registry'].list(), []);
    assert.deepEqual(await workspaceAdmin.x['skills-registry'].ceiling.get({ engine: 'hermes', targetId: 'scripted' }), { ceiling: 'suggest' });

    const github = deployment.inbox.github;
    assert.deepEqual(await github.configure({ repositories: [] }), { ok: true });
    assert.equal((await github.status()).mode, 'observe');
    assert.equal((await github.poll()).created, 1);
    assert.equal(await github.pullRequest({ repo: 'fixture/repo', branch: 'main', commit: 'a'.repeat(40) }), null);
    const upstream = deployment.inbox.upstream;
    assert.deepEqual(await upstream.configure({ botId: null }), { ok: true });
    assert.equal((await upstream.status()).botId, null);
    assert.equal((await upstream.check()).drift, 1);
    await assert.rejects(workspaceAdmin.inbox.github.status(), forbidden);
    await assert.rejects(workspaceAdmin.inbox.upstream.check(), forbidden);
    assert.deepEqual((await deployment.inbox.list()).slice(0, 3).map(item => item.id), ['binding', 'upstream', 'github']);
    assert.equal((await workspaceAdmin.inbox.list()).some(item => item.id === 'github' || item.id === 'upstream'), false);

    const accept = { id: 'upstream' };
    const approval = { id: 'github', decision: 'approve', reason: 'fixture review' } as const;
    for (const [inbox, isOwner] of [[workspaceAdmin.inbox, false], [deployment.inbox, true]] as const) {
      const actions = [
        () => inbox.accept(accept), () => inbox.dismiss({ id: 'github' }), () => inbox.approval.decide(approval),
        () => inbox.reply({ id: 'upstream', answer: 'fixture reply' }), () => inbox.retry({ id: 'github' }),
      ];
      if (!isOwner) {
        for (const action of actions) await assert.rejects(action(), notFound);
      } else {
        assert.deepEqual(await Promise.all(actions.map(async (action) => (await action()).text)),
          ['accept:owner', 'dismiss:owner', 'approval/decide:owner', 'reply:', 'retry:']);
      }
    }
    await assert.rejects(workspaceAdmin.inbox.cron.delete({ id: 'system-upstream' }), notFound);
    assert.deepEqual(await deployment.inbox.cron.delete({ id: 'system-upstream' }), { deleted: true });
    console.log('P1-14_DEPLOYMENT_ROUTES PASS all groups denied before availability; owner with viewer role can manage shared resources');
  } finally { await fixture.cleanup(); }
});
