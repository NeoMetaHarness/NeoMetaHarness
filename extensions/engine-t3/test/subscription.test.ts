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

test('authorization URLs redact existing credentials and account hints', async () => {
  const logs: unknown[][] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.log = console.error = console.warn = (...args) => { logs.push(args); };
  try {
    const state = { instanceId: 'codex', phase: 'waiting', flowId: 'fake-flow',
      interaction: { type: 'browser', url: 'https://example.invalid/sign-in?state=keep&id_token_hint=fake-private-token&login_hint=fake%40example.invalid&id_token_hint=second-token' } };
    const service = new T3Subscription(async (method) => method === 'server.getConfig'
      ? { providers: [codex] } : state, async () => state);
    for (const result of [await service.start('codex'), await service.poll('codex')]) {
      assert.equal(result.verificationUrl, 'https://example.invalid/sign-in?state=keep');
      assert.doesNotMatch(JSON.stringify(result), /id_token_hint|login_hint|fake-private-token|second-token|fake%40example/);
    }
    assert.doesNotMatch(JSON.stringify(logs), /id_token_hint|login_hint|fake-private-token|second-token|fake%40example/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
});

test('cancellation uses the native T3 flow identifier', async () => {
  const service = new T3Subscription(async (method, input) => {
    if (method === 'server.getConfig') return { providers: [codex, claude] };
    assert.equal(method, 'provider.auth.cancel');
    assert.deepEqual(input, { instanceId: 'codex', flowId: 'fake-flow' });
    return { instanceId: 'codex', phase: 'cancelled', flowId: 'fake-flow' };
  }, async () => { throw new Error('unexpected subscription'); });
  assert.equal((await service.cancel('codex', 'fake-flow')).phase, 'cancelled');
  await assert.rejects(service.cancel('claudeAgent', 'fake-flow'), /does not support/);
});

test('poll reports expired and terminal T3 states without exposing upstream diagnostics', async () => {
  const expiresAt = '2000-01-01T00:00:00.000Z';
  const states = [
    { phase: 'waiting', expiresAt },
    { phase: 'failed', expiresAt: null, message: 'Sign-in expired. fake-private-token' },
    { phase: 'cancelled', expiresAt: null },
    { phase: 'failed', expiresAt: null, message: 'Provider error: fake-private-token' },
  ] as const;
  let index = 0;
  const service = new T3Subscription(async () => ({ providers: [codex] }), async () => ({
    instanceId: 'codex', flowId: 'fake-flow', ...states[index++],
  }));
  for (const state of states) {
    const result = await service.poll('codex');
    assert.equal(result.phase, state.phase);
    assert.equal(result.expiresAt, state.expiresAt);
    assert.equal(result.verificationUrl, null);
    assert.equal(result.userCode, null);
    assert.doesNotMatch(JSON.stringify(result), /fake-private-token|message/);
  }
});

test('disconnected T3 reports failure without returning provider state or diagnostics', async () => {
  const service = new T3Subscription(async () => { throw new Error('T3 is disconnected'); },
    async () => { throw new Error('unexpected subscription'); });
  await assert.rejects(service.status(), /T3 is disconnected/);
  await assert.rejects(service.start('codex'), /T3 is disconnected/);
  await assert.rejects(service.poll('codex'), /T3 is disconnected/);
  await assert.rejects(service.cancel('codex', 'fake-flow'), /T3 is disconnected/);
  const disconnectedDuringPoll = new T3Subscription(async () => ({ providers: [codex] }),
    async () => { throw new Error('T3 disconnected: fake-private-token'); });
  await assert.rejects(disconnectedDuringPoll.poll('codex'), { message: 'T3 could not read ChatGPT sign-in status.' });
});

test('native logout is available for managed signed-in Codex and honors an explicit denial', async () => {
  let allowed = true;
  const service = new T3Subscription(async (method, input) => {
    if (method === 'server.getConfig') return { providers: [
      { ...codex, auth: { status: 'authenticated', type: 'chatgpt', canLogout: allowed } },
    ] };
    assert.equal(method, 'provider.auth.logout');
    assert.deepEqual(input, { instanceId: 'codex' });
    return { instanceId: 'codex', phase: 'idle' };
  }, async () => { throw new Error('unexpected snapshot'); });
  assert.equal((await service.status()).providers[0]?.canLogout, true);
  assert.equal((await service.status(false)).providers[0]?.canLogout, false);
  assert.equal((await service.logout('codex')).phase, 'idle');
  allowed = false;
  assert.equal((await service.status()).providers[0]?.canLogout, false);
  await assert.rejects(service.logout('codex'), /does not support ChatGPT sign-out/);
});