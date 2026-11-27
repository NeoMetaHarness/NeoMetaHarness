import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';

async function eventually(read, description) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

const app = fileURLToPath(new URL('..', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'neo-p7-17-'));
const chromeBinary = process.env.CHROME ?? (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : 'google-chrome');

let server, chrome, socket;
try {
  server = await preview({ root: app, configFile: false, preview: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const settings = `${origin}/onboarding?gateway=${encodeURIComponent(origin)}`;
  chrome = spawn(chromeBinary, ['--headless=new', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--disable-extensions', 'about:blank'],
  { stdio: 'ignore', windowsHide: true });
  let chromeError;
  chrome.on('error', (error) => { chromeError = error; });
  const port = await eventually(async () => {
    if (chromeError) throw chromeError;
    if (chrome.exitCode !== null) throw new Error(`Chrome exited ${chrome.exitCode}`);
    const data = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
    return Number(data.split('\n')[0]);
  }, 'Chrome DevTools port');
  const [page] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  let onLoad;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Page.loadEventFired') onLoad?.();
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, (response) => response.error ? reject(new Error(response.error.message)) : resolve(response.result));
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true });
    assert.ok(!exceptionDetails, result.description);
    return result.value;
  };
  const load = async (method, params) => {
    let timeout;
    const loaded = new Promise((resolve, reject) => {
      onLoad = resolve;
      timeout = setTimeout(() => reject(new Error('Document did not finish loading')), 15000);
    });
    try {
      await Promise.all([send(method, params), loaded]);
    } finally {
      clearTimeout(timeout);
      onLoad = undefined;
    }
  };
  function installFake() {
    const fake = window.__subscriptionFake = {
      calls: [], profiles: [{ name: 'alternate-bot' }], providers: [], selection: null,
      starts: 0, polls: 0, runStarts: [], cancelCalls: [], roleReads: [],
      hermesSignedInProfiles: { default: false, 'first-bot': false, 'alternate-bot': true },
      approve: false, errorNextPoll: false, failNextPoll: false, deferNextPoll: false, pendingPoll: null,
      nextExpiresIn: 60, deferNextCancel: false, pendingCancel: null,
      lastPollSignal: null, t3SignedIn: false, role: 'admin',
    };
    fake.resolvePendingPoll = (status = 'approved') => {
      const pending = fake.pendingPoll;
      if (!pending) return false;
      if (status === 'approved') fake.hermesSignedInProfiles[pending.profile] = true;
      fake.pendingPoll = null;
      pending.resolve(Response.json({ json: {
        sessionId: pending.sessionId, status, signedIn: status === 'approved',
      } }));
      return true;
    };
    const nativeFetch = window.fetch.bind(window);
    const flow = (phase) => ({
      instanceId: 'codex', phase, flowId: 'fake-t3-flow', expiresAt: null,
      verificationUrl: 'https://example.invalid/authorize', userCode: null,
    });
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (!/^\/(x|onboarding|extensions|auth)\//.test(path)) return nativeFetch(input, init);
      const data = (await request.json().catch(() => ({}))).json ?? {};
      fake.calls.push({ path, data });
      if (/^\/x\/engine-(hermes|t3)\/subscription\/(status|start|poll|cancel|logout)$/.test(path)
          && !['admin', 'owner'].includes(fake.role)) {
        return Response.json({ json: { defined: false, code: 'FORBIDDEN', status: 403, message: 'Admin required' } }, { status: 403 });
      }
      let result;
      switch (path) {
        case '/auth/organization/get-active-member-role':
          fake.roleReads.push(fake.role);
          return Response.json(fake.role === null ? {} : { role: fake.role });
        case '/onboarding/get':
          result = { completed: false, completedAt: null, ownerName: 'Fake Owner', workspaceName: 'Fake Workspace', mode: 'desktop' }; break;
        case '/extensions/enable': result = { id: data.id, status: 'running' }; break;
        case '/x/models/providers/list': result = fake.providers; break;
        case '/x/models/roles/get': result = {}; break;
        case '/x/models/providers/put':
          fake.providers = [...fake.providers.filter(item => item.id !== data.id), data];
          result = data; break;
        case '/x/models/override/set':
          fake.selection = data; result = { selection: data }; break;
        case '/x/models/override/get': result = { selection: fake.selection }; break;
        case '/x/engine-hermes/install/status': result = { state: 'ready' }; break;
        case '/x/engine-hermes/profiles/list': result = { profiles: fake.profiles }; break;
        case '/x/engine-hermes/profiles/create':
          result = { ok: true, name: data.name, path: '/fake/' + data.name };
          fake.profiles.push(result); break;
        case '/x/engine-hermes/subscription/status':
          result = { signedIn: fake.hermesSignedInProfiles[data.profile] === true,
            canLogout: fake.hermesSignedInProfiles[data.profile] === true }; break;
        case '/x/engine-hermes/subscription/start':
          fake.starts++;
          result = { sessionId: 'fake-' + fake.starts, verificationUrl: 'https://example.invalid/authorize', userCode: 'FAKE-CODE', pollInterval: 0.25, expiresIn: fake.nextExpiresIn };
          fake.nextExpiresIn = 60;
          break;
        case '/x/engine-hermes/subscription/poll':
          fake.polls++;
          fake.lastPollSignal = request.signal;
          if (fake.deferNextPoll) {
            fake.deferNextPoll = false;
            return new Promise((resolve) => {
              fake.pendingPoll = { profile: data.profile, sessionId: data.sessionId, resolve };
            });
          }
          if (fake.failNextPoll) {
            fake.failNextPoll = false;
            throw new Error('Scripted subscription polling failure');
          }
          if (fake.errorNextPoll) {
            fake.errorNextPoll = false;
            result = { sessionId: data.sessionId, status: 'error', signedIn: false };
            break;
          }
          if (fake.approve) fake.hermesSignedInProfiles[data.profile] = true;
          result = { sessionId: data.sessionId, status: fake.approve ? 'approved' : 'pending', signedIn: fake.approve };
          break;
        case '/x/engine-hermes/subscription/cancel':
          fake.cancelCalls.push(data);
          result = { sessionId: data.sessionId, status: 'cancelled', signedIn: false };
          if (fake.deferNextCancel) {
            fake.deferNextCancel = false;
            return new Promise((resolve) => {
              fake.pendingCancel = () => {
                fake.pendingCancel = null;
                resolve(Response.json({ json: result }));
              };
            });
          }
          break;
        case '/x/engine-hermes/subscription/logout':
          fake.hermesSignedInProfiles[data.profile] = false;
          result = { signedIn: false, canLogout: false }; break;
        case '/x/engine-hermes/runs/start':
          fake.runStarts.push(data);
          result = { run_id: 'fake-run-' + fake.runStarts.length }; break;
        case '/x/engine-t3/subscription/status':
          result = { providers: [
            { instanceId: 'codex', provider: 'codex', status: fake.t3SignedIn ? 'authenticated' : 'unauthenticated', signedIn: fake.t3SignedIn, canStart: true, canLogout: fake.t3SignedIn, accountLabel: null, guidance: 'Codex account status from T3.' },
            { instanceId: 'claudeAgent', provider: 'claude', status: 'authenticated', signedIn: true, canStart: false, canLogout: false, accountLabel: 'Claude', guidance: 'Claude account detected by T3.' },
          ] }; break;
        case '/x/engine-t3/subscription/start': result = flow('waiting'); break;
        case '/x/engine-t3/subscription/poll': fake.t3SignedIn = true; result = flow('succeeded'); break;
        case '/x/engine-t3/subscription/cancel': result = flow('cancelled'); break;
        case '/x/engine-t3/subscription/logout': fake.t3SignedIn = false; result = flow('cancelled'); break;
        default: throw new Error('Unexpected fake RPC ' + path);
      }
      return Response.json({ json: result });
    };
  }

  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: '(' + installFake.toString() + ')()' });
  await load('Page.navigate', { url: settings });
  const selector = (id) => 'document.querySelector(' + JSON.stringify('[data-testid="' + id + '"]') + ')';
  const visible = (id) => eventually(() => evaluate('!!' + selector(id)), id);
  const click = async (id) => {
    const element = selector(id);
    await eventually(() => evaluate(element + ' && !' + element + '.disabled && ' + element + '.getAttribute("aria-disabled") !== "true"'), id + ' enabled');
    await evaluate(element + '.click()');
  };
  const clickBack = async () => {
    await eventually(() => evaluate('Array.from(document.querySelectorAll("button")).some(button => button.textContent.trim() === "Back")'), 'Back navigation');
    await evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim() === "Back").click()');
  };
  const value = (id) => evaluate(selector(id) + '.value');
  const waitText = (text) => eventually(() => evaluate('document.body.innerText.includes(' + JSON.stringify(text) + ')'), text);
  await click('onboarding-owner-next');
  await click('local-preset-ollama');
  assert.equal(await value('onboarding-provider-id'), 'ollama');
  assert.equal(await value('onboarding-provider-url'), 'http://127.0.0.1:11434/v1');
  assert.equal(await evaluate('window.__subscriptionFake.starts'), 0);
  await click('onboarding-subscription-next');
  await click('onboarding-bot-create');
  const prefix = 'subscription-hermes-first-bot';
  await evaluate('window.__subscriptionFake.deferNextPoll = true');
  await click(prefix + '-start');
  await eventually(() => evaluate('window.__subscriptionFake.pendingPoll !== null'), 'held Hermes approval poll');
  await waitText('Waiting for approval');
  assert.equal(await evaluate('!document.querySelector("[data-testid=onboarding-channel-next]") && !document.querySelector("[data-testid=onboarding-chat-send]")'), true,
    'the channel and first-chat steps stay unavailable while Hermes approval is pending');
  assert.equal(await evaluate('window.__subscriptionFake.runStarts.length'), 0, 'no first chat run starts before bot-profile approval');
  await clickBack();
  await eventually(() => evaluate('!!document.querySelector("[data-testid=onboarding-wizard] [data-stage=model]")'), 'return to model step');
  await eventually(() => evaluate('window.__subscriptionFake.cancelCalls.length > 0'), 'pending Hermes approval cancellation');
  assert.equal(await evaluate('window.__subscriptionFake.lastPollSignal.aborted'), true, 'Back aborts the pending approval poll');
  assert.equal(await evaluate('window.__subscriptionFake.resolvePendingPoll("approved")'), true, 'release a late approval response after navigation');
  await delay(350);
  assert.equal(await evaluate('!!document.querySelector("[data-testid=onboarding-wizard] [data-stage=model]")'), true,
    'a late approval response cannot advance onboarding to the channel step');
  assert.equal(await evaluate('!document.querySelector("[data-testid=onboarding-channel-next]") && !document.querySelector("[data-testid=onboarding-chat-send]")'), true);
  assert.equal(await evaluate('window.__subscriptionFake.runStarts.length'), 0);

  await evaluate('window.__subscriptionFake.hermesSignedInProfiles["first-bot"] = false; window.__subscriptionFake.approve = false');
  await click('onboarding-subscription-next');
  await click('onboarding-bot-create');
  await visible(prefix);
  await click(prefix + '-start');
  await eventually(() => evaluate('window.__subscriptionFake.polls > 1'), 'Hermes pending poll after returning to bot step');
  await waitText('Waiting for approval');
  await click(prefix + '-cancel');
  const assertOnboardingRetry = async (message) => {
    await eventually(() => evaluate(`(() => { const row = ${selector(prefix)}; const retry = ${selector(prefix + '-start')}; return row.querySelector('[role="alert"]')?.innerText.includes(${JSON.stringify(message)}) && retry?.textContent.trim() === 'Retry' && !retry.disabled && retry.getAttribute('aria-disabled') !== 'true' && !row.innerText.includes('FAKE-CODE') && !row.querySelector('a[href="https://example.invalid/authorize"]'); })()`), message + ' with enabled Retry and cleared authorization details');
    assert.equal(await evaluate('window.__subscriptionFake.runStarts.length'), 0, 'a failed sign-in cannot start the first chat');
  };
  await evaluate('window.__subscriptionFake.errorNextPoll = true');
  await click(prefix + '-start');
  await assertOnboardingRetry('Sign-in did not complete. Please retry.');
  await evaluate('window.__subscriptionFake.failNextPoll = true');
  await click(prefix + '-start');
  await assertOnboardingRetry('Could not check sign-in status. Please retry.');
  await click(prefix + '-start');
  await eventually(() => evaluate('window.__subscriptionFake.starts === 5'), 'Hermes retry');
  await waitText('Waiting for approval');
  await evaluate('window.__subscriptionFake.approve = true');
  await visible('onboarding-created-bot');
  assert.equal(await evaluate(selector('onboarding-created-bot') + '.textContent'), 'first-bot');
  const state = await evaluate('window.__subscriptionFake');
  assert.equal(state.selection.profile, 'first-bot');
  assert.equal(state.providers[0].engines.hermes.profile, 'first-bot');
  assert.equal(state.selection.providerId, state.providers[0].id);
  const created = state.calls.findIndex(call => call.path.endsWith('/profiles/create'));
  assert.ok(created >= 0);
  assert.ok(state.calls.filter(call => call.path.includes('/engine-hermes/subscription/')).every(call => call.data.profile === 'first-bot'));
  assert.ok(state.calls.findIndex(call => call.path.endsWith('/subscription/start')) > created);
  assert.equal(state.runStarts.length, 0, 'approval advances onboarding without automatically starting a chat');

  await click('onboarding-channel-next');
  await visible('onboarding-chat-message');
  await evaluate(selector('onboarding-chat-message') + '.focus()');
  await evaluate(selector('onboarding-chat-message') + '.select()');
  await send('Input.insertText', { text: 'Hello from the first bot' });
  await click('onboarding-chat-send');
  await eventually(() => evaluate('window.__subscriptionFake.runStarts.length === 1'), 'first chat run start after approval');
  const firstChat = await evaluate('window.__subscriptionFake.runStarts[0]');
  assert.equal(firstChat.profile, 'first-bot');
  assert.equal(firstChat.input, 'Hello from the first bot');

  await evaluate(`window.__subscriptionFake.providers.push({ id: 'chatgpt-alt', name: 'Alternate profile subscription', kind: 'subscription', vendor: 'openai', status: 'signed-in', engines: { hermes: { status: 'signed-in', profile: 'alternate-bot' } } });`);
  await evaluate('history.pushState({}, "", "/settings/models" + location.search); window.dispatchEvent(new PopStateEvent("popstate"));');
  await visible('settings-models');
  await waitText('Saved subscription status');
  await waitText('Hermes · signed-in · profile first-bot');
  await waitText('Claude sign-in detected');
  await waitText('Sign out in T3');
  const claudeSignOut = await evaluate(`(() => {
    const row = Array.from(document.querySelectorAll('.subscription-row')).find(item => item.innerText.includes('Claude sign-in detected'));
    return row ? { guidance: row.innerText.includes('Sign out in T3'), signOutControl: !!row.querySelector('button') } : null;
  })()`);
  assert.deepEqual(claudeSignOut, { guidance: true, signOutControl: false },
    'authenticated Claude without a logout seam shows Sign out in T3 guidance');
  await visible('subscription-hermes-profile');
  await visible('models-provider-id');
  await visible('subscription-t3-codex-start');

  await evaluate('window.__subscriptionFake.approve = false; window.__subscriptionFake.failNextPoll = true');
  await click('subscription-hermes-default-start');
  await waitText('FAKE-CODE');
  await eventually(() => evaluate('!!document.querySelector("[data-testid=subscription-hermes-default] [role=alert]")'), 'Model Hub polling error alert');
  const pollFailure = await evaluate(`(() => { const row = ${selector('subscription-hermes-default')}; const retry = row.querySelector('[data-testid="subscription-hermes-default-start"]'); return { alert: !!row.querySelector('[role="alert"]'), retry: !!retry && retry.textContent.trim() === 'Retry' && !retry.disabled, code: row.innerText.includes('FAKE-CODE'), url: !!row.querySelector('a[href="https://example.invalid/authorize"]') }; })()`);
  assert.deepEqual(pollFailure, { alert: true, retry: true, code: false, url: false },
    'a failed Model Hub poll clears the device code and URL, announces an alert, and exposes Retry');
  assert.equal(await evaluate(`(() => { const fake = window.__subscriptionFake; return fake.cancelCalls.some(call => call.profile === 'default' && call.sessionId === 'fake-' + fake.starts); })()`), true,
    'a failed poll cancels the current remote Hermes session');

  await evaluate('window.__subscriptionFake.nextExpiresIn = 2; window.__subscriptionFake.deferNextCancel = true');
  await click('subscription-hermes-default-start');
  await eventually(() => evaluate(`(() => { const row = ${selector('subscription-hermes-default')}; return row.innerText.includes('FAKE-CODE') && !!row.querySelector('a[href="https://example.invalid/authorize"]'); })()`), 'device code and authorization URL before expiry');
  await eventually(() => evaluate(`(() => { const fake = window.__subscriptionFake; return !!fake.pendingCancel && fake.cancelCalls.some(call => call.profile === 'default' && call.sessionId === 'fake-' + fake.starts); })()`), 'expired remote session cancellation');
  await eventually(() => evaluate(`(() => { const row = ${selector('subscription-hermes-default')}; return !row.innerText.includes('FAKE-CODE') && !row.querySelector('a[href="https://example.invalid/authorize"]'); })()`), 'expired authorization details cleared before cancellation resolves');
  await evaluate('window.__subscriptionFake.pendingCancel()');
  await eventually(() => evaluate(`(() => { const row = ${selector('subscription-hermes-default')}; const retry = row.querySelector('[data-testid="subscription-hermes-default-start"]'); return row.querySelector('[role="alert"]')?.innerText.includes('Sign-in expired') && retry?.textContent.trim() === 'Retry' && !retry.disabled && retry.getAttribute('aria-disabled') !== 'true' && !row.innerText.includes('FAKE-CODE') && !row.querySelector('a[href="https://example.invalid/authorize"]'); })()`), 'expiry alert and enabled Retry with authorization details cleared');

  await evaluate('window.__subscriptionFake.nextExpiresIn = 2; window.__subscriptionFake.deferNextPoll = true');
  await click('subscription-hermes-default-start');
  await eventually(() => evaluate('window.__subscriptionFake.pendingPoll !== null'), 'held Model Hub poll before expiry');
  await eventually(() => evaluate(`(() => { const row = ${selector('subscription-hermes-default')}; return row.innerText.includes('FAKE-CODE') && !!row.querySelector('a[href="https://example.invalid/authorize"]'); })()`), 'authorization details while poll is held');
  await eventually(() => evaluate(`(() => { const fake = window.__subscriptionFake; return !!fake.pendingPoll && fake.lastPollSignal.aborted && fake.cancelCalls.some(call => call.profile === 'default' && call.sessionId === fake.pendingPoll.sessionId); })()`), 'deadline aborts the unresolved poll and cancels its remote session');
  const expiredPoll = () => evaluate(`(() => { const row = ${selector('subscription-hermes-default')}; const retry = ${selector('subscription-hermes-default-start')}; return row.querySelector('[role="alert"]')?.innerText.includes('Sign-in expired. Please retry.') && retry?.textContent.trim() === 'Retry' && !retry.disabled && retry.getAttribute('aria-disabled') !== 'true' && !row.innerText.includes('FAKE-CODE') && !row.querySelector('a[href="https://example.invalid/authorize"]'); })()`);
  await eventually(expiredPoll, 'unresolved poll expiry alert and enabled Retry with authorization details cleared');
  assert.equal(await evaluate('window.__subscriptionFake.resolvePendingPoll("pending")'), true, 'release the poll response after expiry');
  await delay(350);
  assert.equal(await expiredPoll(), true, 'late polling response cannot restore expired authorization details or replace the expiry alert');

  await click('subscription-hermes-profile');
  await eventually(() => evaluate('!!document.querySelector("[role=listbox] [role=option]")'), 'Hermes profile options');
  await evaluate('Array.from(document.querySelectorAll("[role=listbox] [role=option]")).find(option => option.textContent.trim() === "alternate-bot").click()');
  await eventually(() => evaluate(selector('subscription-hermes-profile') + '.textContent.trim() === "alternate-bot"'), 'alternate Hermes profile selection');
  await eventually(() => evaluate('window.__subscriptionFake.calls.some(call => call.path.endsWith("/subscription/status") && call.data.profile === "alternate-bot")'), 'alternate Hermes profile status request');
  await visible('subscription-hermes-alternate-bot-logout');
  assert.equal(await evaluate('window.__subscriptionFake.hermesSignedInProfiles["alternate-bot"]'), true,
    'switching profiles reads the selected Hermes profile sign-in status');
  await click('subscription-hermes-alternate-bot-logout');
  await eventually(() => evaluate('window.__subscriptionFake.hermesSignedInProfiles["alternate-bot"] === false && window.__subscriptionFake.providers.some(provider => provider.engines?.hermes?.profile === "alternate-bot" && provider.engines.hermes.status === "signed-out")'), 'Hermes profile sign-out saved');
  await waitText('Hermes · signed-out · profile alternate-bot');
  assert.equal(await evaluate('window.__subscriptionFake.calls.some(call => call.path.endsWith("/subscription/logout") && call.data.profile === "alternate-bot")'), true,
    'sign-out targets the selected Hermes profile');

  await click('local-preset-lm-studio');
  assert.equal(await value('models-provider-id'), 'lm-studio');
  assert.equal(await value('models-provider-url'), 'http://127.0.0.1:1234/v1');
  await click('subscription-t3-codex-start');
  await eventually(() => evaluate('window.__subscriptionFake.providers.some(p => p.engines?.t3?.status === "signed-in")'), 'T3 subscription saved');
  await waitText('T3 · signed-in');
  await waitText('Signed in');

  const assertReadOnlyRole = async (role) => {
    await evaluate('history.pushState({}, "", "/settings" + location.search); window.dispatchEvent(new PopStateEvent("popstate"));');
    await visible('settings-models-open');
    await evaluate('window.__subscriptionFake.role = ' + JSON.stringify(role));
    const callOffset = await evaluate('window.__subscriptionFake.calls.length');
    const roleOffset = await evaluate('window.__subscriptionFake.roleReads.length');
    await evaluate('history.pushState({}, "", "/settings/models" + location.search); window.dispatchEvent(new PopStateEvent("popstate"));');
    await visible('settings-models');
    await eventually(() => evaluate('window.__subscriptionFake.roleReads.slice(' + roleOffset + ').includes(' + JSON.stringify(role) + ')'), role + ' workspace role lookup');
    await waitText('Saved subscription status');
    await waitText('Hermes · signed-in · profile first-bot');
    await waitText('Hermes · signed-out · profile alternate-bot');
    await waitText('T3 · signed-in');
    await delay(100);
    const state = await evaluate(`(() => ({
      providerForm: !!document.querySelector('[data-testid="models-provider-id"]'),
      providerSave: !!document.querySelector('[data-testid="models-save-provider"]'),
      providerActions: !!document.querySelector('.models-list .models-actions'),
      localPreset: !!document.querySelector('[data-testid="local-preset-ollama"]'),
      roleMapping: !!document.querySelector('[data-testid="models-role-default-provider"]'),
      roleSave: !!document.querySelector('[data-testid="models-save-role-default"]'),
      botOverride: !!document.querySelector('[data-testid="models-bot-profile"]'),
      overrideSave: !!document.querySelector('[data-testid="models-save-override"]'),
      hermesProfile: !!document.querySelector('[data-testid="subscription-hermes-profile"]'),
      subscriptionActions: !!document.querySelector('.subscription-actions button'),
      savedStatus: document.body.innerText.includes('Saved subscription status'),
      hermesStatus: document.body.innerText.includes('Hermes · signed-in · profile first-bot'),
      alternateStatus: document.body.innerText.includes('Hermes · signed-out · profile alternate-bot'),
      t3Status: document.body.innerText.includes('T3 · signed-in'),
      error: !!document.querySelector('[data-testid="settings-models"] [role="alert"]'),
      liveSubscriptionCalls: window.__subscriptionFake.calls.slice(${callOffset}).filter(call => /^\\/x\\/engine-(hermes|t3)\\/subscription\\//.test(call.path)),
    }))()`);
    assert.deepEqual(state, {
      providerForm: false, providerSave: false, providerActions: false, localPreset: false,
      roleMapping: false, roleSave: false, botOverride: false, overrideSave: false,
      hermesProfile: false, subscriptionActions: false,
      savedStatus: true, hermesStatus: true, alternateStatus: true, t3Status: true, error: false, liveSubscriptionCalls: [],
    }, `${role} can read Model Hub status without provider-management or sign-in controls`);
  };
  await assertReadOnlyRole('member');
  await assertReadOnlyRole('viewer');
  await assertReadOnlyRole(null);
  await assertReadOnlyRole('unknown-role');
  console.log('P7-17 scripted subscription UI PASS');
} finally {
  socket?.close();
  if (chrome?.pid) {
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(chrome.pid), '/T', '/F'], { windowsHide: true });
    else chrome.kill();
  }
  await server?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
}
