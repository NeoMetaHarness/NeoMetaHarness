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
        id: 'binding', source: 'neo/channel', text: 'Hermes binding fixture',
        botId: 'fake', mode: 'observe', status: 'suggestion', createdAt: 1, updatedAt: 1,
      }]);
    } };`);
  }
  await writeExtension(join(extensionsDir, id), '1.0.0');
  await writeExtension(candidate, '2.0.0');
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
  return { id, upgrade, start, stop, cleanup, client, authPost, signup, createOrg };
}

test('P1-14 server: first identity owns the deployment, and transfer survives restart', async () => {
  const fixture = await prepareFixture('server');
  try {
    let gateway = await fixture.start();
    const founder = await fixture.signup('founder@deployment.test');
    const other = await fixture.signup('owner@workspace-b.test');
    assert.equal((await fixture.createOrg('TooEarly', other.token)).status, 403);
    assert.equal((await fixture.createOrg('WorkspaceA', founder.token)).status, 200);
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
    await assert.rejects(workspaceOwner.system.transferDeploymentOwner({ userId: other.user.id }), forbidden);
    await assert.rejects(workspaceOwner.extensions.upgrade({ ...fixture.upgrade, id: 'absent-extension' }), forbidden);
    await assert.rejects(workspaceOwner.extensions.upgrade(fixture.upgrade), forbidden);
    assert.equal((await deployment.extensions.upgrade(fixture.upgrade)).upgraded, true);
    await assert.rejects(workspaceOwner.extensions.uninstall({ id: fixture.id }), forbidden);
    await assert.rejects(deployment.system.transferDeploymentOwner({ userId: 'absent-user' }),
      (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND');
    assert.deepEqual(await deployment.system.transferDeploymentOwner({ userId: other.user.id }), { userId: other.user.id });
    await assert.rejects(deployment.extensions.uninstall({ id: fixture.id }), forbidden);

    await fixture.stop();
    gateway = await fixture.start();
    assert.equal((await fixture.createOrg('FormerOwner', founder.token)).status, 403);
    assert.equal((await fixture.createOrg('NewOwner', other.token)).status, 200);
    assert.deepEqual(await fixture.client(founder.token).inbox.list(), []);
    const newOwner = fixture.client(other.token);
    assert.deepEqual((await newOwner.inbox.list()).map(item => item.id), ['binding']);
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
    assert.deepEqual((await client.inbox.list()).map(item => item.id), ['binding']);
    assert.equal((await client.extensions.upgrade(fixture.upgrade)).upgraded, true);
    await assert.rejects(client.system.transferDeploymentOwner({ userId: 'absent-user' }),
      (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND');
    assert.equal((await client.extensions.uninstall({ id: fixture.id })).version, '1.0.0');
    console.log('P1-14_DESKTOP PASS bootstrap, Inbox, and extension lifecycle remain available');
  } finally { await fixture.cleanup(); }
});
