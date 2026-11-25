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
      calls: [], profiles: [], providers: [], selection: null,
      starts: 0, polls: 0, hermesSignedIn: false, approve: false, t3SignedIn: false,
    };
    const nativeFetch = window.fetch.bind(window);
    const flow = (phase) => ({
      instanceId: 'codex', phase, flowId: 'fake-t3-flow', expiresAt: null,
      verificationUrl: 'https://example.invalid/authorize', userCode: null,
    });
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (!/^\/(x|onboarding|extensions)\//.test(path)) return nativeFetch(input, init);
      const data = (await request.json().catch(() => ({}))).json ?? {};
      fake.calls.push({ path, data });
      let result;
      switch (path) {
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
          result = { signedIn: data.profile === 'first-bot' && fake.hermesSignedIn, canLogout: data.profile === 'first-bot' && fake.hermesSignedIn }; break;
        case '/x/engine-hermes/subscription/start':
          fake.starts++;
          result = { sessionId: 'fake-' + fake.starts, verificationUrl: 'https://example.invalid/authorize', userCode: 'FAKE-CODE', pollInterval: 0.25, expiresIn: 60 }; break;
        case '/x/engine-hermes/subscription/poll':
          fake.polls++;
          if (fake.starts === 2) result = { sessionId: data.sessionId, status: 'error', signedIn: false };
          else {
            fake.hermesSignedIn = fake.approve;
            result = { sessionId: data.sessionId, status: fake.approve ? 'approved' : 'pending', signedIn: fake.approve };
          }
          break;
        case '/x/engine-hermes/subscription/cancel':
          result = { sessionId: data.sessionId, status: 'cancelled', signedIn: false }; break;
        case '/x/engine-t3/subscription/status':
          result = { providers: [
            { instanceId: 'codex', provider: 'codex', status: fake.t3SignedIn ? 'authenticated' : 'unauthenticated', signedIn: fake.t3SignedIn, canStart: true, canLogout: fake.t3SignedIn, accountLabel: null, guidance: 'Sign in through T3' },
            { instanceId: 'claudeAgent', provider: 'claude', status: 'authenticated', signedIn: true, canStart: false, canLogout: false, accountLabel: 'Claude', guidance: 'Claude sign-in detected by T3.' },
          ] }; break;
        case '/x/engine-t3/subscription/start': result = flow('waiting'); break;
        case '/x/engine-t3/subscription/poll': fake.t3SignedIn = true; result = flow('succeeded'); break;
        case '/x/engine-t3/subscription/cancel': result = flow('cancelled'); break;
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
  await click(prefix + '-start');
  await eventually(() => evaluate('window.__subscriptionFake.polls > 0'), 'Hermes pending poll');
  await waitText('Waiting for approval');
  await click(prefix + '-cancel');
  await click(prefix + '-start');
  await waitText('Sign-in did not complete');
  await click(prefix + '-start');
  await eventually(() => evaluate('window.__subscriptionFake.starts === 3'), 'Hermes retry');
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

  await evaluate('history.pushState({}, "", "/settings/models" + location.search); window.dispatchEvent(new PopStateEvent("popstate"));');
  await visible('settings-models');
  await waitText('openai subscription');
  await waitText('signed-in');
  await waitText('Claude sign-in detected');
  await click('local-preset-lm-studio');
  assert.equal(await value('models-provider-id'), 'lm-studio');
  assert.equal(await value('models-provider-url'), 'http://127.0.0.1:1234/v1');
  await click('subscription-t3-codex-start');
  await eventually(() => evaluate('window.__subscriptionFake.providers.some(p => p.engines?.t3?.status === "signed-in")'), 'T3 subscription saved');
  await waitText('Signed in');
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
