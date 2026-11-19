import assert from 'node:assert/strict';
import { ComputerRegistry, type ComputerNotice, type ComputerProvider } from '../src/index.js';
const events: ComputerNotice[] = [];
const registry = new ComputerRegistry(() => 'http://127.0.0.1/internal/computers/action', (event) => events.push(event));
for (const providerId of ['fake', 'headless-chrome', 'local-sandbox', 'vnc']) {
  let actions = 0; let fail = false;
  const provider: ComputerProvider = {
    capabilities: { screen: true, input: true, browserCdp: false, shell: false, files: false, snapshot: false },
    provision() { return this.attach('fake'); },
    attach() { return { screen: () => ({ protocol: 'png' }), lease() {}, capture() { actions++; return { png: 'fake', width: 1, height: 1 }; },
      input() { actions++; if (fail) throw Error('fake provider failure'); }, navigate() { actions++; } }; },
    release() {},
  };
  const detach = registry.registerProvider(providerId, provider);
  const id = `${providerId}-screen`; await registry.attach(providerId, id);
  const { token } = registry.assign('hermes', providerId, id);
  await registry.act(token, { action: 'click', x: 1, y: 2 });
  await registry.lease(id, 'human'); const before = actions;
  for (const action of [{ action: 'capture' } as const, { action: 'type', text: 'NEVER_AUDIT_CONTENT' } as const]) await assert.rejects(registry.act(token, action), /human/);
  assert.equal(actions, before);
  assert.deepEqual((await registry.act(token, { action: 'status' })).lease, { holder: 'human', engaged: false });
  await registry.lease(id, 'agent'); registry.kill(true);
  await assert.rejects(registry.act(token, { action: 'click', x: 1, y: 2 }), /kill/); registry.kill(false);
  for (const keys of ['DELETE', 'Backspace', 'CTRL+ALT+DELETE', 'Meta+Q', 'Ctrl+L']) await assert.rejects(registry.act(token, { action: 'key', keys }), /policy/);
  await assert.rejects(registry.act(token, { action: 'navigate', url: 'https://allowed.test/path' }), /policy/);
  registry.setPolicy(id, { allowDestructiveKeys: true, navigationOrigins: ['https://allowed.test'] });
  await registry.act(token, { action: 'key', keys: 'DELETE' });
  await registry.act(token, { action: 'navigate', url: 'https://allowed.test/path' });
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://evil.test/', 'https://user:pass@allowed.test/']) await assert.rejects(registry.act(token, { action: 'navigate', url }), /policy/);
  await assert.rejects(registry.act(token, { action: 'click', x: 0, y: 0 }, () => false), /revoked/);
  fail = true; await assert.rejects(registry.act(token, { action: 'click', x: 0, y: 0 }), /fake provider/);
  const audits = events.filter((event): event is Extract<ComputerNotice, { type: 'computer.action' }> =>
    event.type === 'computer.action' && event.providerId === providerId);
  assert.ok(audits.some((event) => event.outcome === 'allowed'));
  assert.ok(audits.some((event) => event.outcome === 'denied'));
  assert.ok(audits.some((event) => event.outcome === 'failed'));
  assert.ok(!JSON.stringify(events).includes('NEVER_AUDIT_CONTENT'));
  await detach(); await assert.rejects(registry.act(token, { action: 'click', x: 0, y: 0 }), /denied/);
}
console.log('PASS computer safety baseline: four provider doubles, human lease, kill, key/navigation policy and redacted allowed/denied/failed audit events');
