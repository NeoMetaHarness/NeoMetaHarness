import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HermesSubscription } from '../src/subscription.js';

const path = '/api/providers/oauth/openai-codex';
const start = {
  session_id: 'fake-session', flow: 'device_code', user_code: 'FAKE-CODE',
  verification_url: 'https://auth.openai.com/codex/device', expires_in: 900, poll_interval: 5,
  access_token: 'fake-ignored',
};

function scripted(steps: Array<[string, string, object, number?]>) {
  const subscription = new HermesSubscription(async (url, method = 'GET') => {
    const step = steps.shift();
    assert.ok(step, 'unexpected dashboard call');
    assert.deepEqual([method, url], step.slice(0, 2));
    return Response.json(step[2], { status: step[3] ?? 200 });
  });
  return { subscription, done: () => assert.equal(steps.length, 0) };
}

test('device sign-in returns code and polls to approval without exposing credentials', async () => {
  const { subscription, done } = scripted([
    ['POST', path + '/start?profile=bot', start],
    ['GET', path + '/poll/fake-session?profile=bot', { session_id: 'fake-session', status: 'pending' }],
    ['GET', path + '/poll/fake-session?profile=bot', { session_id: 'fake-session', status: 'approved', token: 'fake-ignored' }],
  ]);
  assert.deepEqual(await subscription.start('bot'), {
    sessionId: 'fake-session', userCode: 'FAKE-CODE', verificationUrl: start.verification_url,
    expiresIn: 900, pollInterval: 5,
  });
  assert.deepEqual(await subscription.poll('bot', 'fake-session'), {
    sessionId: 'fake-session', status: 'pending', signedIn: false,
  });
  assert.deepEqual(await subscription.poll('bot', 'fake-session'), {
    sessionId: 'fake-session', status: 'approved', signedIn: true, accountLabel: 'ChatGPT / Codex',
  });
  done();
});

test('expired code reports expiry with no credential or upstream error body', async () => {
  const { subscription, done } = scripted([
    ['POST', path + '/start', start],
    ['GET', path + '/poll/fake-session', { session_id: 'fake-session', status: 'expired', error_message: 'fake-ignored' }],
  ]);
  await subscription.start('default');
  assert.deepEqual(await subscription.poll('default', 'fake-session'), {
    sessionId: 'fake-session', status: 'expired', signedIn: false,
  });
  done();
});

test('cancel delegates to the Hermes worker cancellation endpoint', async () => {
  const { subscription, done } = scripted([
    ['POST', path + '/start', start],
    ['GET', path + '/poll/fake-session', { session_id: 'fake-session', status: 'pending' }],
    ['GET', '/api/providers/oauth', { providers: [{ id: 'openai-codex', status: { logged_in: false } }] }],
    ['DELETE', '/api/providers/oauth/sessions/fake-session', { ok: true, session_id: 'fake-session' }],
    ['GET', path + '/poll/fake-session', { detail: 'Session not found or expired' }, 404],
    ['GET', '/api/providers/oauth', { providers: [{ id: 'openai-codex', status: { logged_in: false } }] }],
  ]);
  await subscription.start('default');
  assert.deepEqual(await subscription.cancel('default', 'fake-session'), {
    sessionId: 'fake-session', status: 'cancelled', signedIn: false,
  });
  done();
});

test('approval between poll and DELETE wins over cancellation', async () => {
  for (const reply of [{ ok: true, session_id: 'fake-session' }, { ok: false, message: 'session not found' }]) {
    const { subscription, done } = scripted([
      ['GET', path + '/poll/fake-session', { session_id: 'fake-session', status: 'pending' }],
      ['GET', '/api/providers/oauth', { providers: [{ id: 'openai-codex', status: { logged_in: false } }] }],
      ['DELETE', '/api/providers/oauth/sessions/fake-session', reply],
      ['GET', path + '/poll/fake-session', { session_id: 'fake-session', status: 'approved' }],
    ]);
    assert.deepEqual(await subscription.cancel('default', 'fake-session'), {
      sessionId: 'fake-session', status: 'approved', signedIn: true, accountLabel: 'ChatGPT / Codex',
    });
    done();
  }
});

test('approval survives the pinned dashboard removing the session on DELETE', async () => {
  const { subscription, done } = scripted([
    ['GET', path + '/poll/fake-session?profile=bot', { session_id: 'fake-session', status: 'pending' }],
    ['GET', '/api/providers/oauth?profile=bot', { providers: [{ id: 'openai-codex', status: { logged_in: false } }] }],
    ['DELETE', '/api/providers/oauth/sessions/fake-session?profile=bot', { ok: true, session_id: 'fake-session' }],
    ['GET', path + '/poll/fake-session?profile=bot', { detail: 'Session not found or expired' }, 404],
    ['GET', '/api/providers/oauth?profile=bot', { providers: [{ id: 'openai-codex', status: { logged_in: true } }] }],
  ]);
  assert.deepEqual(await subscription.cancel('bot', 'fake-session'), {
    sessionId: 'fake-session', status: 'approved', signedIn: true, accountLabel: 'ChatGPT / Codex',
  });
  done();
});

test('cancelling a session on an already signed-in profile preserves the existing login', async () => {
  const { subscription, done } = scripted([
    ['GET', path + '/poll/fake-session?profile=bot', { session_id: 'fake-session', status: 'pending' }],
    ['GET', '/api/providers/oauth?profile=bot', { providers: [{ id: 'openai-codex', status: { logged_in: true } }] }],
    ['DELETE', '/api/providers/oauth/sessions/fake-session?profile=bot', { ok: true, session_id: 'fake-session' }],
    ['GET', path + '/poll/fake-session?profile=bot', {}, 404],
    ['GET', '/api/providers/oauth?profile=bot', { providers: [{ id: 'openai-codex', status: { logged_in: true } }] }],
  ]);
  assert.deepEqual(await subscription.cancel('bot', 'fake-session'), {
    sessionId: 'fake-session', status: 'cancelled', signedIn: true,
  });
  done();
});
