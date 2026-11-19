import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { startGateway } from '../../gateway/src/server.ts';
import { authorize } from '../../gateway/src/policy.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const root = await mkdtemp(join(tmpdir(), 'neo-p38-'));
const calls = [];
const drivers = [];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAAAAC0lEQVR42mP8/x8AAwMCAO+/uVUAAAAASUVORK5CYII=';

class FakeLocalDriver {
  closed = false;
  pendingInput;
  constructor() { drivers.push(this); }
  screenshot() { calls.push('screenshot'); return Promise.resolve({ png, width: 1, height: 1 }); }
  click(x, y) { calls.push(`click:${x},${y}`); return this.action('click'); }
  move(x, y) { calls.push(`move:${x},${y}`); return Promise.resolve(); }
  type(text) { calls.push(`type:${text}`); return Promise.resolve(); }
  key(keys) { calls.push(`key:${keys}`); return Promise.resolve(); }
  scroll(direction, amount) { calls.push(`scroll:${direction},${amount}`); return Promise.resolve(); }
  action(name) {
    if (name !== 'click' || !FakeLocalDriver.holdClick) return Promise.resolve();
    return new Promise((resolve, reject) => { this.pendingInput = { resolve, reject }; });
  }
  close() {
    this.closed = true;
    this.pendingInput?.reject(new Error('Fake driver interrupted'));
    this.pendingInput = undefined;
  }
}

let gateway;
try {
  const assets = (await readdir(join(repo, 'apps/neo-app/dist/assets'))).filter(name => /^Computers-.*\.js$/.test(name));
  assert.ok(assets.length, 'build first: missing Computers page chunk');
  assert.match(await readFile(join(repo, 'apps/neo-app/dist/assets', assets[0]), 'utf8'), /Agent acting/);
  gateway = await startGateway({
    databaseFile: join(root, 'neo.sqlite'), dataDir: root, extensionsDir: join(repo, 'extensions'),
    mode: 'desktop', computerLocalDriverFactory: () => new FakeLocalDriver(),
  });
  const base = `http://127.0.0.1:${gateway.port}`;
  const rpc = createORPCClient(new RPCLink({ url: base, headers: { authorization: `Bearer ${gateway.desktopToken}` } }));
  const anonymous = createORPCClient(new RPCLink({ url: base }));
  assert.deepEqual(await rpc.computers.local.status(), { available: false, enabled: false });
  await assert.rejects(anonymous.computers.local.set({ enabled: true }), error => error.code === 'UNAUTHORIZED');
  const memberContext = { user: { id: 'test', name: 'member', email: 'member@local.invalid' }, role: 'member' };
  const adminContext = { ...memberContext, role: 'admin' };
  assert.throws(() => authorize('computers.local.set', memberContext), error => error.code === 'FORBIDDEN');
  assert.throws(() => authorize('computers.local.set', adminContext), error => error.code === 'FORBIDDEN');
  await rpc.extensions.enable({ id: 'computer-fake' });
  assert.equal((await rpc.extensions.enable({ id: 'computer-local' })).status, 'running');
  assert.deepEqual(await rpc.computers.local.status(), { available: true, enabled: false });
  await assert.rejects(rpc.computers.attach({ providerId: 'computer-local', target: 'local-desktop' }), error => error.code === 'BAD_REQUEST');
  assert.equal(drivers.length, 0, 'off by default: fake driver not instantiated');

  await rpc.computers.local.set({ enabled: true });
  await rpc.computers.attach({ providerId: 'computer-local', target: 'local-desktop' });
  await rpc.computers.assign({ engine: 'hermes', targetId: 'scripted-p38', computerId: 'local-desktop' });
  const binding = gateway.computers.binding('hermes', 'scripted-p38');
  const act = (action) => fetch(binding.endpoint, { method: 'POST', headers: {
    authorization: `Bearer ${binding.token}`, 'content-type': 'application/json',
  }, body: JSON.stringify(action) });
  assert.equal((await act({ action: 'click', x: 8, y: 9 })).status, 200);
  assert.equal((await act({ action: 'type', text: 'fake-only' })).status, 200);
  // P3-7's shared safety layer blocks key chords until an admin opts this computer in.
  assert.equal((await act({ action: 'key', keys: 'Ctrl+A' })).status, 403);
  await rpc.computers.policy.set({ id: 'local-desktop', allowDestructiveKeys: true, navigationOrigins: [] });
  assert.equal((await act({ action: 'key', keys: 'Ctrl+A' })).status, 200);
  assert.equal((await act({ action: 'move', x: 1, y: 2 })).status, 200);
  assert.equal((await act({ action: 'scroll', direction: 'down', amount: 4 })).status, 200);
  assert.equal((await act({ action: 'capture' })).status, 200);
  assert.deepEqual(calls, ['click:8,9', 'type:fake-only', 'key:Ctrl+A', 'move:1,2', 'scroll:down,4', 'screenshot']);

  const notices = [];
  for await (const event of gateway.kernel.events.subscribe(0)) {
    if (event.type === 'computer.acting' && event.computerId === 'local-desktop') notices.push(event);
    if (notices.length === 12) break;
  }
  assert.deepEqual(notices.map(e => e.active), [true, false, true, false, true, false, true, false, true, false, true, false]);

  await rpc.computers.lease({ id: 'local-desktop', holder: 'human' });
  assert.equal((await act({ action: 'type', text: 'should-block' })).status, 403);
  assert.equal((await rpc.computers.capture({ id: 'local-desktop' })).width, 1);
  await rpc.computers.lease({ id: 'local-desktop', holder: 'agent' });
  await rpc.computers.kill({ engaged: true });
  assert.equal((await act({ action: 'click', x: 3, y: 4 })).status, 403);
  await rpc.computers.kill({ engaged: false });
  assert.equal((await act({ action: 'key', keys: 'Escape' })).status, 200);

  // A human takeover interrupts a running fake input, before queued input starts.
  FakeLocalDriver.holdClick = true;
  const pending = act({ action: 'click', x: 22, y: 23 });
  for (let tries = 0; !calls.includes('click:22,23') && tries < 100; tries++) {
    await new Promise(done => setTimeout(done, 10));
  }
  assert.ok(calls.includes('click:22,23'));
  const takeover = rpc.computers.lease({ id: 'local-desktop', holder: 'human' });
  assert.equal((await pending).status, 403);
  await takeover;
  FakeLocalDriver.holdClick = false;

  await rpc.computers.local.set({ enabled: false });
  assert.deepEqual(await rpc.computers.local.status(), { available: true, enabled: false });
  assert.equal((await rpc.computers.list()).some(x => x.id === 'local-desktop'), false);
  assert.equal((await act({ action: 'key', keys: 'x' })).status, 403);
  assert.ok(drivers.every(driver => driver.closed));
  await rpc.extensions.disable({ id: 'computer-local' });
  assert.deepEqual(await rpc.computers.local.status(), { available: false, enabled: false });
  assert.equal((await rpc.extensions.list()).find(x => x.id === 'computer-fake').status, 'running');
  await rpc.computers.attach({ providerId: 'computer-fake', target: 'other-healthy' });
  await rpc.computers.release({ id: 'other-healthy' });
  console.log('PASS P3-8 authenticated gateway, fake-only inputs, owner opt-in, acting event, preemptive human lease, kill, disable isolation, and built indicator');
} finally {
  await gateway?.close();
  await rm(root, { recursive: true, force: true });
}
