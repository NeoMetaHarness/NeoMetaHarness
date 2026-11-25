import assert from 'node:assert/strict';
import { test } from 'node:test';
import { T3Subscription } from '../src/subscription.js';

const codex = { instanceId: 'codex', driver: 'codex', enabled: true, setup: { canAuthenticate: true } };
const claude = { instanceId: 'claudeAgent', driver: 'claudeAgent', enabled: true };

test('signed-in subscriptions use only T3-reported authentication metadata', async () => {
  const service = new T3Subscription(async (method, input) => {
    assert.equal(method, 'server.getConfig'); assert.deepEqual(input, {});
    return { providers: [
      { ...codex, auth: { status: 'authenticated', type: 'chatgpt', token: 'fake-token' } },
      { ...claude, auth: { status: 'authenticated', type: 'max', token: 'fake-token' } },
      { ...codex, instanceId: 'api', auth: { status: 'authenticated', type: 'apiKey' } },
    ] };
  }, async () => { throw new Error('unexpected subscription'); });
  const result = await service.status();
  assert.deepEqual(result.providers.map((provider) => provider.signedIn), [true, true, false]);
  assert.equal(result.providers[1]?.canStart, false);
  assert.ok(!JSON.stringify(result).includes('fake-token'));
  const external = await service.status(false);
  assert.equal(external.providers[0]?.signedIn, true);
  assert.equal(external.providers[0]?.canStart, false);
  assert.match(external.providers[0]!.guidance, /isolated local T3 server/);
});

test('signed-out and unknown providers report guidance without calling login', async () => {
  const service = new T3Subscription(async (method) => {
    assert.equal(method, 'server.getConfig');
    return { providers: [{ ...codex, auth: { status: 'unauthenticated' } }, { ...claude, auth: { status: 'unknown' } }] };
  }, async () => { throw new Error('unexpected subscription'); });
  const { providers } = await service.status();
  assert.deepEqual(providers.map((provider) => provider.signedIn), [false, false]);
  assert.match(providers[1]!.guidance, /claude auth login/);
  await assert.rejects(service.start('claudeAgent'), /does not support/);
});

test('ChatGPT starts through the native server callback and polls T3 state', async () => {
  const state = { instanceId: 'codex', phase: 'waiting', flowId: 'fake-flow', interaction: {
    type: 'browser', url: 'https://example.invalid/sign-in', token: 'fake-token' }, token: 'fake-token' };
  const service = new T3Subscription(async (method, input) => {
    if (method === 'server.getConfig') return { providers: [codex, claude] };
    assert.equal(method, 'provider.auth.start');
    assert.deepEqual(input, { instanceId: 'codex', methodId: 'chatgpt', callbackMode: 'server' });
    return state;
  }, async (instanceId) => { assert.equal(instanceId, 'codex'); return { ...state, phase: 'succeeded', interaction: null }; });
  const started = await service.start('codex');
  assert.equal(started.phase, 'waiting');
  assert.equal(started.verificationUrl, 'https://example.invalid/sign-in');
  assert.ok(!JSON.stringify(started).includes('fake-token'));
  assert.equal((await service.poll('codex')).phase, 'succeeded');
});
