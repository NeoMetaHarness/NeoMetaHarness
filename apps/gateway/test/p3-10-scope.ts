import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { startGateway } from '../src/server.js';
import { projectHermesComputer } from '@neometaharness/computers/hermes';

const root = await mkdtemp(join(tmpdir(), 'neo-computer-scope-'));
await mkdir(join(root, 'extensions'));
const gateway = await startGateway({ databaseFile: join(root, 'gateway.sqlite'), dataDir: root,
  mode: 'server', signup: 'open', extensionsDir: join(root, 'extensions') });
try {
  const base = `http://127.0.0.1:${gateway.port}`;
  const request = async (path: string, body: object, token?: string) => {
    const response = await fetch(base + '/auth/' + path, { method: 'POST', headers: {
      'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
    }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, `${path} status ${response.status}`);
    return response.json() as Promise<any>;
  };
  await request('sign-up/email', { email: 'scope@neo.test', password: 'TestPassword!123', name: 'Scope Owner' });
  const token = (await request('sign-in/email', { email: 'scope@neo.test', password: 'TestPassword!123' })).token;
  const orgA = await request('organization/create', { name: 'Workspace Alpha', slug: `alpha-${randomUUID()}` }, token);
  const orgB = await request('organization/create', { name: 'Workspace Bravo', slug: `bravo-${randomUUID()}` }, token);
  const client = async (workspaceId: string) => {
    const apiKey = await request('api-key/create', { name: `scope-${workspaceId.slice(0, 8)}`,
      expiresIn: 3600, metadata: { workspaceId, role: 'admin' } }, token);
    return createORPCClient<any>(new RPCLink({ url: base, headers: { 'x-api-key': apiKey.key } }));
  };
  const rpcA = await client(orgA.id);
  const rpcB = await client(orgB.id);
  const capabilities = { screen: true, input: true, browserCdp: false, shell: false, files: false, snapshot: false };
  const driver = () => ({ screen: () => ({ protocol: 'png' as const }), lease: () => {}, input: () => {},
    capture: () => ({ png: 'fake', width: 1, height: 1 }) });
  const unregister = gateway.computers.registerProvider('scope-fake', {
    capabilities, provision: () => driver(), attach: () => driver(), release: () => {},
  });
  try {
    const computerA = await rpcA.computers.provision({ providerId: 'scope-fake', spec: {} });
    const computerB = await rpcB.computers.provision({ providerId: 'scope-fake', spec: {} });
    const unscoped = await gateway.computers.attach('scope-fake', 'unscoped-legacy');
    const listA = await rpcA.computers.list();
    const listB = await rpcB.computers.list();
    assert.deepEqual(listA.map((item: any) => item.id), [computerA.id]);
    assert.deepEqual(listB.map((item: any) => item.id), [computerB.id]);
    assert.ok(!listA.some((item: any) => item.id === unscoped.id));
    await assert.rejects(rpcA.computers.capture({ id: computerB.id }));
    await assert.rejects(rpcA.computers.lease({ id: computerB.id, holder: 'human' }));
    await assert.rejects(rpcA.computers.release({ id: computerB.id }));
    await assert.rejects(rpcA.computers.capture({ id: unscoped.id }));
    await assert.rejects(rpcA.computers.release({ id: unscoped.id }));
    assert.equal((await rpcB.computers.capture({ id: computerB.id })).png, 'fake');
    const botA = randomUUID();
    const botB = randomUUID();
    await gateway.db.agents.createBot({ id: botA, name: 'Owned by A', created_at: Date.now(), workspace_id: orgA.id });
    await gateway.db.agents.createBot({ id: botB, name: 'Owned by B', created_at: Date.now(), workspace_id: orgB.id });
    const profileB = `neo_${botB.replace(/-/g, '')}`;
    await rpcB.computers.assign({ engine: 'hermes', targetId: profileB, computerId: computerB.id });
    const before = gateway.computers.binding('hermes', profileB, orgB.id);
    assert.ok(before);
    const profileHome = join(root, 'hermes-profile');
    await mkdir(profileHome);
    assert.equal(await projectHermesComputer(gateway.computers, profileB, profileHome, orgB.id), before.token);
    assert.equal(await projectHermesComputer(gateway.computers, profileB, profileHome, orgA.id), undefined);
    await assert.rejects(rpcA.computers.assign({ engine: 'hermes', targetId: profileB, computerId: computerA.id }),
      (error: any) => error.code === 'NOT_FOUND');
    await assert.rejects(rpcA.computers.assign({ engine: 'hermes', targetId: `neo_${botA.replace(/-/g, '')}`, computerId: computerB.id }));
    assert.deepEqual(gateway.computers.binding('hermes', profileB, orgB.id), before);
    assert.equal(gateway.computers.binding('hermes', profileB, orgA.id), undefined);
    assert.ok(!gateway.computers.binding('hermes', profileB));
    await rpcA.computers.kill({ engaged: true });
    assert.equal(gateway.computers.state(orgA.id).engaged, true);
    assert.equal(gateway.computers.state(orgB.id).engaged, false);
    await rpcA.computers.kill({ engaged: false });
    assert.equal((await rpcB.computers.list()).length, 1);
    await rpcB.computers.release({ id: computerB.id });
  } finally { await unregister(); }
  console.log('P3-10 SCOPE PASS two-workspace-target-owner=true assignment-isolated=true unscoped-closed=true list-capture-lease-release-kill=true');
} finally {
  await gateway.close();
  await rm(root, { recursive: true, force: true });
}
