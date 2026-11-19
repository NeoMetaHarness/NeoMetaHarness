import assert from 'node:assert/strict';
import test from 'node:test';
import { ComputerRegistry, type ComputerNotice } from '@neometaharness/computers';
import { LocalComputerProvider, LOCAL_DESKTOP_ID, type LocalDriver } from '../src/provider.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uVUAAAAASUVORK5CYII=';

function fixture() {
  const calls: string[] = [], notices: ComputerNotice[] = [];
  let closeCount = 0;
  const factory = (): LocalDriver => ({
    async screenshot() { calls.push('screenshot'); return { png, width: 1, height: 1 }; },
    async click(x, y) { calls.push(`click:${x},${y}`); },
    async move(x, y) { calls.push(`move:${x},${y}`); },
    async type(text) { calls.push(`type:${text}`); },
    async key(keys) { calls.push(`key:${keys}`); },
    async scroll(direction, amount) { calls.push(`scroll:${direction},${amount}`); },
    close() { closeCount++; },
  });
  const provider = new LocalComputerProvider(factory);
  const registry = new ComputerRegistry(() => 'http://127.0.0.1:0/internal/computers/action', e => notices.push(e));
  const unregister = registry.registerProvider('computer-local', provider);
  return { provider, registry, unregister, calls, notices, get closes() { return closeCount; } };
}

test('local provider is opt-in, routes every action via the driver, and revokes on opt-out', async () => {
  const f = fixture();
  await assert.rejects(f.registry.attach('computer-local', LOCAL_DESKTOP_ID), /not enabled/);
  f.provider.setEnabled(true);
  await f.registry.attach('computer-local', LOCAL_DESKTOP_ID);
  const binding = f.registry.assign('hermes', 'bot', LOCAL_DESKTOP_ID);
  assert.deepEqual((await f.registry.act(binding.token, { action: 'capture' })).capture, { png, width: 1, height: 1 });
  for (const action of [
    { action: 'click', x: 10, y: 20 }, { action: 'move', x: 3, y: 4 },
    { action: 'type', text: 'safe' }, { action: 'key', keys: 'Ctrl+A' },
    { action: 'scroll', direction: 'down', amount: 2 },
  ] as const) await f.registry.act(binding.token, action);
  assert.deepEqual(f.calls, ['screenshot', 'click:10,20', 'move:3,4', 'type:safe', 'key:Ctrl+A', 'scroll:down,2']);
  assert.deepEqual(f.notices.filter(n => n.type === 'computer.acting').map(n => n.active),
    [true, false, true, false, true, false, true, false, true, false, true, false]);
  f.provider.setEnabled(false);
  await assert.rejects(f.registry.act(binding.token, { action: 'key', keys: 'Enter' }), /unavailable/);
  assert.ok(f.closes > 0);
  await f.registry.release(LOCAL_DESKTOP_ID);
  await f.unregister();
});

test('human lease and kill switch preempt native input and permit read-only screenshots', async () => {
  const f = fixture();
  f.provider.setEnabled(true);
  await f.registry.attach('computer-local', LOCAL_DESKTOP_ID);
  const token = f.registry.assign('dsh', 'session', LOCAL_DESKTOP_ID).token;
  await f.registry.lease(LOCAL_DESKTOP_ID, 'human');
  await assert.rejects(f.registry.act(token, { action: 'type', text: 'blocked' }), /leased to a human/);
  assert.equal((await f.registry.capture(LOCAL_DESKTOP_ID)).width, 1);
  await f.registry.lease(LOCAL_DESKTOP_ID, 'agent');
  f.registry.kill(true);
  await assert.rejects(f.registry.act(token, { action: 'click', x: 2, y: 3 }), /kill switch/);
  assert.equal((await f.registry.capture(LOCAL_DESKTOP_ID)).width, 1);
  f.registry.kill(false);
  await f.registry.act(token, { action: 'type', text: 'back' });
  assert.deepEqual(f.calls.filter(c => c.startsWith('type:')), ['type:back']);
  await f.unregister();
});
