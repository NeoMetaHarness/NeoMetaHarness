import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { WebSocketServer, type WebSocket } from 'ws';
import { startGateway } from '../src/server.js';

type Client = ContractRouterClient<typeof neoContract>;
const jpeg = "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAADAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCHAKQD/9k=";
const root = await mkdtemp(join(tmpdir(), 'neo-p39-'));
const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise<void>(resolve => fake.once('listening', resolve));
const address = fake.address();
if (!address || typeof address === 'string') throw new Error('Fake Hermes listener unavailable');
const fakeUrl = `ws://127.0.0.1:${address.port}/api/ws`;
const sockets = new Set<WebSocket>();
const seen: string[] = [];
let nativeHuman = false;
let accepted = 0;
let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;

// Hermes v0.23.2 hermes_cli/web_routers/chat_ws.py:650 and
// tui_gateway/methods_display.py:50,60. No native Hermes process is started.
fake.on('connection', (socket, request) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/api/ws' || url.searchParams.get('token') !== 'fake-hermes-session') {
    socket.close(1008);
    return;
  }
  accepted++;
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('message', message => {
    const rpc = JSON.parse(message.toString()) as { id: number; method: string; params: { profile?: string } };
    seen.push(rpc.method);
    assert.equal(rpc.params.profile, 'default', 'Hermes requests are profile-scoped');
    const result = rpc.method === 'display.status' ? { running: true }
      : rpc.method === 'display.thumbnail' ? { data_url: nativeHuman ? null : `data:image/jpeg;base64,${jpeg}`, suppressed: nativeHuman ? 'human_has_control' : undefined }
      : null;
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
});

async function eventually(check: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(label + ' timed out');
}

try {
  gateway = await startGateway({
    databaseFile: join(root, 'neo.sqlite'), dataDir: root,
    extensionsDir: resolve('..', '..', 'extensions'), mode: 'desktop',
    hermesScreenBridge: {
      async connect(profile, workspaceId, token) {
        assert.equal(profile, 'default');
        const inVault = await gateway!.vault.get({ kind: 'engine', workspaceId, subjectId: `engine-hermes/${profile}` }, 'NEO_SCREEN_VIEW_TOKEN');
        assert.ok(inVault && /^[a-f0-9]{64}$/.test(inVault));
        assert.equal(token, inVault, 'per-workspace and per-profile secret is verified');
        return { url: fakeUrl, sessionToken: 'fake-hermes-session' };
      },
    },
  });
  const token = gateway.desktopToken;
  assert.ok(token, 'desktop authentication token');
  const base = `http://127.0.0.1:${gateway.port}`;
  const rpc = createORPCClient<Client>(new RPCLink({ url: base, headers: { authorization: `Bearer ${token}` } }));
  const anonymous = createORPCClient<Client>(new RPCLink({ url: base }));
  const attach = { providerId: 'computer-hermes-screen', target: 'hermes-screen:default' };
  await assert.rejects(anonymous.computers.attach(attach), (error: any) => error.code === 'UNAUTHORIZED');
  assert.equal((await rpc.extensions.enable({ id: 'sample-ts' })).status, 'running');
  assert.equal((await rpc.extensions.enable({ id: 'computer-hermes-screen' })).status, 'running');
  await assert.rejects(rpc.computers.attach({ ...attach, target: 'hermes-screen:../private' }), (error: any) => error.code === 'BAD_REQUEST');

  const screen = await rpc.computers.attach(attach);
  assert.equal(screen.holder, 'agent');
  assert.equal(screen.capabilities.screen, true);
  assert.equal(screen.capabilities.input, false);
  assert.equal(accepted, 1);
  const frame = await rpc.computers.capture({ id: screen.id });
  assert.deepEqual([frame.width, frame.height], [4, 3]);
  assert.ok(Buffer.from(frame.png, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  assert.ok(seen.includes('display.status') && seen.includes('display.thumbnail'));

  await rpc.computers.assign({ engine: 'hermes', targetId: 'p39-bot', computerId: screen.id });
  const binding = gateway.computers.binding('hermes', 'p39-bot');
  assert.ok(binding);
  const action = (name: string) => fetch(binding.endpoint, {
    method: 'POST', headers: { authorization: `Bearer ${binding.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: name, x: 1, y: 1 }),
  });
  assert.equal((await action('status')).status, 200);
  assert.equal((await action('click')).status, 403, 'screen bridge is read-only');
  await rpc.computers.lease({ id: screen.id, holder: 'human' });
  assert.equal((await action('capture')).status, 403, 'Neo human lease wins');
  nativeHuman = true;
  await assert.rejects(rpc.computers.capture({ id: screen.id }), 'native Hermes human lease suppresses screen');
  nativeHuman = false;
  assert.equal((await rpc.computers.capture({ id: screen.id })).width, 4, 'viewer stays available under Neo lease');
  await rpc.computers.lease({ id: screen.id, holder: 'agent' });
  await rpc.computers.kill({ engaged: true });
  assert.equal((await action('capture')).status, 403, 'global kill wins');
  assert.equal((await rpc.computers.capture({ id: screen.id })).width, 4, 'kill keeps viewer available');
  await rpc.computers.kill({ engaged: false });
  assert.equal((await action('capture')).status, 200);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 1500);
  let audited = false;
  try {
    for await (const event of gateway.kernel.events.subscribe(0, controller.signal)) {
      if (event.type === 'computer.action' && event.providerId === 'computer-hermes-screen' && event.outcome === 'denied') {
        audited = true;
        break;
      }
    }
  } finally { clearTimeout(deadline); }
  assert.ok(audited, 'the shared safety layer audits denied actions');
  assert.deepEqual(await rpc.computers.release({ id: screen.id }), { released: true });
  await eventually(() => sockets.size === 0, 'release closes Hermes socket');

  await rpc.computers.attach(attach);
  await rpc.extensions.disable({ id: 'computer-hermes-screen' });
  await eventually(() => sockets.size === 0, 'disable closes Hermes socket');
  assert.equal((await rpc.computers.list()).length, 0);
  await assert.rejects(rpc.computers.attach(attach), (error: any) => error.code === 'BAD_REQUEST');
  assert.equal((await fetch(base + '/x/sample-ts/hello', { headers: { authorization: `Bearer ${token}` } })).status, 200);
  console.log('P3-9 PASS authenticated=true fake-hermes=true vault-profile=true png=true read-only=true human-lease=true native-suppression=true kill=true audit=true release=true disable=true siblings-healthy=true');
} finally {
  if (gateway) await gateway.close();
  for (const socket of sockets) socket.terminate();
  await new Promise<void>(resolve => fake.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
