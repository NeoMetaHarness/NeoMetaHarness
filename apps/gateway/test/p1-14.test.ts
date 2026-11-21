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
import { startGateway } from '../src/server.js';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const org = (name: string) => ({ name, slug: name.toLowerCase(), keepCurrentActiveOrganization: true });
const forbidden = (error: unknown) => (error as { code?: string })?.code === 'FORBIDDEN';
const notFound = (error: unknown) => (error as { code?: string })?.code === 'NOT_FOUND';
const backupInput = { out: 'fixture.neo', passphrase: 'fixture-passphrase' };
const restoreInput = { archive: 'fixture.neo', dataDir: 'fixture-destination', passphrase: 'fixture-passphrase' };

async function prepareFixture(mode: 'server' | 'desktop') {
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
      ctx.route('list', () => [{
        id: 'binding', source: 'neo/binding', text: 'Hermes binding fixture',
        botId: 'fake', mode: 'observe', status: 'suggestion', createdAt: 1, updatedAt: 1,
      }, {
        id: 'private-message', source: 'neo/channel', text: 'Private conversation from workspace B',
        botId: 'fake', mode: 'observe', status: 'suggestion', createdAt: 2, updatedAt: 2,
      }]);
      ctx.route('accept', ({ body }) => { throw new Error('Unexpected scripted accept: ' + body.id); });
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
  const raw = (path: string, token: string) => fetch(base() + path, { headers: bearer(token) });
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
  return { id, upgrade, start, stop, cleanup, client, raw, signup, createOrg };
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
