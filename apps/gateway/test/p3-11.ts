import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { approveHttpsEgress } from '@neometaharness/kernel';
import { BoatComputerProvider } from '../../../extensions/computer-boat/src/provider.js';
import { startGateway } from '../src/server.js';

type Client = ContractRouterClient<typeof neoContract>;
type Recorded = { method: string; path: string; body: Record<string, any>; authorized: boolean; idempotency?: string };
const root = await mkdtemp(join(tmpdir(), 'neo-p311-'));
const calls: Recorded[] = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCj8AAAAASUVORK5CYII=', 'base64');
let sequence = 0;
let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString();
  const body = raw ? JSON.parse(raw) as Record<string, any> : {};
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  const authorized = req.headers.authorization === 'Bearer fake-boat-api-key';
  const entry: Recorded = { method: req.method ?? '', path, body, authorized,
    idempotency: typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined };
  calls.push(entry);
  res.setHeader('content-type', 'application/json');
  if (!authorized) { res.statusCode = 401; res.end(JSON.stringify({ error: 'unauthorized' })); return; }
  if (req.method === 'POST' && (path === '/api/v1/sandboxes' || /\/fork$/.test(path))) {
    const id = ['bx_23456789', 'bx_2345678a', 'bx_2345678b', 'bx_2345678c'][sequence++];
    res.end(JSON.stringify(path.endsWith('/fork') ? { id } : { sandbox: { id } }));
  } else if (req.method === 'POST' && path.endsWith('/desktop')) {
    res.end(JSON.stringify({ success: true, desktopUrl: 'https://fake-boat.example/view' }));
  } else if (req.method === 'POST' && path.endsWith('/commands')) {
    assert.match(body.command, /^python3 -c "/);
    const isCapture = Buffer.from(/b64decode\('([^']+)'\)/.exec(body.command)![1], 'base64').toString().includes("'import','-window'");
    res.end(JSON.stringify({ success: true, exitCode: 0, stdout: isCapture ? png.toString('base64') : '', stderr: '' }));
  } else if (req.method === 'GET' && path.endsWith('/snapshots/latest')) {
    res.end(JSON.stringify({ id: 'snap-one' }));
  } else if (req.method === 'POST' && path.endsWith('/saved-snapshots')) {
    res.end(JSON.stringify({ name: body.name, sandboxId: body.sandboxId }));
  } else if ((req.method === 'POST' && path.endsWith('/stop')) || req.method === 'DELETE') {
    res.end(JSON.stringify({ success: true }));
  } else { res.statusCode = 404; res.end(JSON.stringify({ error: 'unexpected path' })); }
});

try {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Boat fake listener unavailable');
  const fakeBoatHttp = (url: string, init: RequestInit) => {
    assert.equal(new URL(url).host, 'fake-boat.example');
    assert.equal(init.redirect, 'error', 'Boat must refuse HTTP redirects');
    assert.ok(init.signal, 'Boat requests must have a timeout signal');
    return fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, init);
  };
  gateway = await startGateway({ databaseFile: join(root, 'neo.sqlite'), dataDir: root,
    extensionsDir: resolve('..', '..', 'extensions'), mode: 'desktop',
    computerBoatHttp: fakeBoatHttp, computerBoatResolveHost: async () => ['8.8.8.8'] });
  const base = `http://127.0.0.1:${gateway.port}`;
  const token = gateway.desktopToken;
  assert.ok(token);
  const rpc = createORPCClient<Client>(new RPCLink({ url: base, headers: { authorization: `Bearer ${token}` } }));
  const anonymous = createORPCClient<Client>(new RPCLink({ url: base }));
  const workspaceId = (await gateway.auth.kysely.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id;
  const settings = await rpc.settings.set({ extension: 'computer-boat', values: {
    baseUrl: 'https://fake-boat.example/api/v1', apiKey: 'fake-boat-api-key',
  } });
  assert.deepEqual(settings.values.apiKey, { set: true }, 'key is stored in vault and redacted from settings');
  assert.equal((await rpc.extensions.enable({ id: 'computer-boat' })).status, 'running');
  assert.equal((await rpc.extensions.enable({ id: 'sample-ts' })).status, 'running');
  await assert.rejects(anonymous.computers.provision({ providerId: 'computer-boat', spec: {} }),
    (error: any) => error.code === 'UNAUTHORIZED');
  const first = await rpc.computers.provision({ providerId: 'computer-boat', spec: { type: 'small', ttlSeconds: 3600 } });
  assert.equal(first.providerId, 'computer-boat');
  assert.match(first.id, /^neo-[0-9a-f]{24}$/);
  assert.equal(calls[0].idempotency, first.id, 'provision is retry-idempotent');
  assert.equal(calls[0].body.type, 'small');
  assert.equal((await rpc.computers.capture({ id: first.id })).width, 1);
  await rpc.computers.assign({ engine: 'dsh', targetId: 'boat-test', computerId: first.id });
  const binding = gateway.computers.binding('dsh', 'boat-test');
  assert.ok(binding);
  const action = (input: object) => fetch(binding.endpoint, { method: 'POST',
    headers: { authorization: `Bearer ${binding.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal((await action({ action: 'click', x: 2, y: 3 })).status, 200);
  assert.equal((await action({ action: 'type', text: 'safe; $() && spaces' })).status, 200);
  assert.equal((await action({ action: 'key', keys: 'Ctrl+A' })).status, 403, 'destructive key requires policy opt-in');
  assert.equal((await rpc.computers.lease({ id: first.id, holder: 'human' })).holder, 'human');
  assert.equal((await action({ action: 'click', x: 1, y: 1 })).status, 403, 'human lease preempts agent');
  await rpc.computers.lease({ id: first.id, holder: 'agent' });
  await rpc.computers.kill({ engaged: true });
  assert.equal((await action({ action: 'click', x: 1, y: 1 })).status, 403, 'kill stops input');
  await rpc.computers.kill({ engaged: false });
  assert.equal((await action({ action: 'key', keys: 'Enter' })).status, 200);
  await assert.rejects(anonymous.computers.capture({ id: first.id }), (error: any) => error.code === 'UNAUTHORIZED');
  const snapshotRoute = base + '/x/computer-boat/snapshot';
  assert.equal((await fetch(snapshotRoute, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: first.id }) })).status, 401);
  const snapshotResponse = await fetch(snapshotRoute, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', }, body: JSON.stringify({ id: first.id }) });
  assert.equal(snapshotResponse.status, 200, 'owner can save a snapshot');
  assert.ok(calls.some(call => call.path === '/api/v1/saved-snapshots' && call.body.sandboxId === 'bx_23456789'));
  await assert.rejects(rpc.computers.provision({ providerId: 'computer-boat', spec: { forkOf: 'bx_23456789' } }),
    (error: any) => error.code === 'BAD_REQUEST', 'arbitrary remote fork sources are rejected');
  const fork = await rpc.computers.provision({ providerId: 'computer-boat', spec: { forkOf: first.id } });
  assert.ok(calls.some(call => call.path === '/api/v1/sandboxes/bx_23456789/fork'));
  assert.deepEqual(await rpc.computers.release({ id: first.id }), { released: true });
  assert.ok(calls.some(call => call.method === 'POST' && call.path === '/api/v1/sandboxes/bx_23456789/stop'));
  assert.deepEqual(await rpc.computers.terminate({ id: fork.id }), { terminated: true });
  assert.ok(calls.some(call => call.method === 'DELETE' && call.path === '/api/v1/sandboxes/bx_2345678a'));
  const third = await rpc.computers.provision({ providerId: 'computer-boat', spec: {} });
  await rpc.extensions.disable({ id: 'computer-boat' });
  assert.ok(calls.some(call => call.path === '/api/v1/sandboxes/bx_2345678b/stop'));
  assert.ok(!(await rpc.computers.list()).some(entry => entry.id === third.id));
  await assert.rejects(rpc.computers.provision({ providerId: 'computer-boat', spec: {} }),
    (error: any) => error.code === 'BAD_REQUEST');
  assert.equal((await fetch(base + '/x/sample-ts/hello', { headers: { authorization: `Bearer ${token}` } })).status, 200);
  assert.ok(calls.every(call => call.authorized), 'only isolated fake server receives key');
  assert.ok(calls.every(call => !JSON.stringify(call.body).includes('fake-boat-api-key')), 'key never travels in bodies');
  const separateProvider = new BoatComputerProvider(
    () => ({ baseUrl: 'https://fake-boat.example/api/v1', apiKey: 'fake-boat-api-key' }),
    fakeBoatHttp, async () => ['8.8.8.8'],
  );
  await separateProvider.provision({ id: 'neo-0123456789abcdef01234567' }, { workspaceId: 'workspace-A' });
  await assert.rejects(separateProvider.saveSnapshot('neo-0123456789abcdef01234567', 'workspace-B'),
    /Unknown Boat computer in workspace/, 'other workspace cannot save the source snapshot');
  await assert.rejects(separateProvider.provision({ id: 'neo-0123456789abcdef01234568', forkOf: 'neo-0123456789abcdef01234567' }, { workspaceId: 'workspace-B' }),
    /same workspace/, 'other workspace cannot fork the source');
  assert.equal(calls.filter(call => call.path === '/api/v1/saved-snapshots').length, 1);
  await separateProvider.terminate('neo-0123456789abcdef01234567');
  await assert.rejects(approveHttpsEgress('http://fake-boat.example', false, async () => ['8.8.8.8']), /HTTPS/);
  for (const address of ['127.0.0.1', '10.1.1.1', '172.16.2.3', '192.168.2.3', '169.254.169.254', '::1', 'fc00::1', 'fe80::1']) {
    await assert.rejects(approveHttpsEgress('https://fake-boat.example', false, async () => [address]),
      /forbidden/, `blocked egress address ${address}`);
  }
  assert.ok(await approveHttpsEgress('https://fake-boat.example', true, async () => ['192.168.1.2']));
  console.log('P3-11 PASS authenticated=true vaulted-settings=true fake-boat-server=true provision+fork+snapshot=true capture+input=true lease+kill+audit-path=true disable-cleanup=true siblings-healthy=true');
} finally {
  if (gateway) await gateway.close();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// Authorization precedes extension availability. A viewer sees 403 in both states.
const authRoot = await mkdtemp(join(tmpdir(), 'neo-p311-auth-'));
const authGateway = await startGateway({
  databaseFile: join(authRoot, 'neo.sqlite'), dataDir: authRoot,
  extensionsDir: resolve('..', '..', 'extensions'), mode: 'server', signup: 'open',
});
try {
  const authBase = `http://127.0.0.1:${authGateway.port}`;
  const signup = async (email: string) => {
    const response = await fetch(`${authBase}/auth/sign-up/email`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, name: email, password: 'Password!12345' }) });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ user: { id: string } }>;
  };
  await signup('boat-owner@neo.local');
  const viewer = await signup('boat-viewer@neo.local');
  const login = async (email: string) => {
    const response = await fetch(`${authBase}/auth/sign-in/email`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'Password!12345' }) });
    assert.equal(response.status, 200);
    return (await response.json() as { token: string }).token;
  };
  const ownerToken = await login('boat-owner@neo.local');
  const viewerToken = await login('boat-viewer@neo.local');
  const created = await fetch(`${authBase}/auth/organization/create`, { method: 'POST',
    headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Boat Workspace', slug: 'boat-workspace' }) });
  assert.equal(created.status, 200);
  const workspace = await created.json() as { id: string };
  await authGateway.auth.api.addMember({ body: {
    organizationId: workspace.id, userId: viewer.user.id, role: 'viewer',
  }, headers: new Headers({ authorization: `Bearer ${ownerToken}` }) });
  const ownerRpc = createORPCClient<Client>(new RPCLink({ url: authBase, headers: { authorization: `Bearer ${ownerToken}` } }));
  const snapshot = () => fetch(`${authBase}/x/computer-boat/snapshot`, { method: 'POST', headers: {
    authorization: `Bearer ${viewerToken}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ id: 'neo-0123456789abcdef01234567' }) });
  assert.equal((await snapshot()).status, 403, 'viewer receives 403 with Boat disabled');
  await ownerRpc.extensions.enable({ id: 'computer-boat' });
  assert.equal((await snapshot()).status, 403, 'viewer receives 403 with Boat enabled');
  console.log('P3-11 AUTH PASS viewer=403 enabled+disabled');
} finally {
  await authGateway.close();
  await rm(authRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
