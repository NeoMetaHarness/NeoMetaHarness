import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';

if (process.platform !== 'win32') throw new Error('P1-8 requires Windows WebView2');

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(appDir, '../..');
const exe = join(appDir, 'src-tauri/target/release/neo-meta-harness.exe');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function eventually(check, label, attempts = 250) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const value = await check();
      if (value) return value;
    } catch { /* startup or navigation still pending */ }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function availablePort() {
  const server = createTcpServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function openWebview(port) {
  const page = await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    return (await response.json()).find((item) => item.type === 'page' && /tauri\.localhost/.test(item.url));
  }, 'WebView2 debugging page');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!pending.has(message.id)) return;
    pending.get(message.id)(message);
    pending.delete(message.id);
  };
  const send = (method, params = {}) => new Promise((done, reject) => {
    const number = ++id;
    pending.set(number, (message) => message.error ? reject(new Error(message.error.message)) : done(message.result));
    socket.send(JSON.stringify({ id: number, method, params }));
  });
  await send('Runtime.enable');
  const evaluate = async (expression) => {
    const answer = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (answer.exceptionDetails) throw new Error(answer.result?.description ?? answer.exceptionDetails.text);
    return answer.result.value;
  };
  const field = (selector, value) => evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('Missing field ${selector}');
    const prototype = element.tagName === 'SELECT' ? HTMLSelectElement.prototype : element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  })()`);
  return {
    evaluate,
    field,
    wait: async (expression, label, attempts) => {
      try {
        return await eventually(() => evaluate(expression), label, attempts);
      } catch (error) {
        const alert = await evaluate('document.querySelector("[role=alert]")?.textContent ?? ""');
        throw new Error(`${error.message}. UI error: ${alert}`);
      }
    },
    close: () => socket.close(),
  };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function closeWindow(pid) {
  const script = `$process = Get-Process -Id ${pid} -ErrorAction Stop; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CloseWindow { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp); }'; if ($process.MainWindowHandle -eq [IntPtr]::Zero -or -not [CloseWindow]::PostMessage($process.MainWindowHandle, 16, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Could not close window' }`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
}

execFileSync(process.execPath, [join(appDir, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: appDir, stdio: 'pipe' });
execFileSync(join(process.env.USERPROFILE, '.cargo/bin/cargo.exe'), ['build', '--release'], {
  cwd: join(appDir, 'src-tauri'), stdio: 'pipe',
});

const home = await mkdtemp(join(tmpdir(), 'nmh-p7-8-'));
const statusFile = join(home, 'ready.json');

// P7-16: P7_8_HERMES=install runs onboarding as on an installed app, where Hermes is not installed yet. The app
// installs it from a local fixture tarball of the pinned commit (no network for the download) against a fixture lock.
const installMode = process.env.P7_8_HERMES === 'install';
let fixtureServer;
let installEnv = {};
if (installMode) {
  const lock = JSON.parse(readFileSync(join(repoDir, 'upstream.lock.json'), 'utf8'));
  const pin = lock.pins['hermes-agent'];
  let cache = process.env.NMH_UPSTREAM_CACHE;
  for (let dir = repoDir; !cache; dir = dirname(dir)) {
    if (existsSync(join(dir, 'nmh-upstream-cache'))) cache = join(dir, 'nmh-upstream-cache');
    else if (dirname(dir) === dir) throw new Error('P7_8_HERMES=install builds its fixture from the upstream cache (set NMH_UPSTREAM_CACHE)');
  }
  const fixture = execFileSync('git', ['-C', join(cache, `hermes-agent@${pin.ref}`), 'archive', '--format=tar.gz',
    `--prefix=hermes-agent-${pin.ref.replace(/^v/, '')}/`, pin.commit], { maxBuffer: 512 * 1024 * 1024 });
  lock.pins['hermes-agent'] = { ...pin, archive_sha256: createHash('sha256').update(fixture).digest('hex') };
  // The super agent, installed from the Inbox at the end.
  const superagentPin = lock.pins['dsh-superagent'];
  const superagentFixture = execFileSync('git', ['-C', join(cache, `dsh-superagent@${superagentPin.ref}`), 'archive', '--format=tar.gz',
    `--prefix=dsh-superagent-prototype-${superagentPin.commit}/`, superagentPin.commit], { maxBuffer: 256 * 1024 * 1024 });
  lock.pins['dsh-superagent'] = { ...superagentPin, archive_sha256: createHash('sha256').update(superagentFixture).digest('hex') };
  const lockFile = join(home, 'upstream.lock.json');
  writeFileSync(lockFile, JSON.stringify(lock, null, 2));
  const fixtures = new Map([[`/${pin.upstream}/tar.gz/${pin.commit}`, fixture],
    [`/${superagentPin.upstream}/tar.gz/${superagentPin.commit}`, superagentFixture]]);
  fixtureServer = createServer((request, response) => {
    const body = fixtures.get(request.url);
    if (!body) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'application/x-gzip', 'content-length': body.length }).end(body);
  });
  await new Promise((done) => fixtureServer.listen(0, '127.0.0.1', done));
  installEnv = {
    NODE_ENV: 'test',
    NMH_TEST_UPSTREAM_LOCK: lockFile,
    NMH_TEST_ENGINE_DOWNLOAD_BASE: `http://127.0.0.1:${fixtureServer.address().port}`,
    NMH_UPSTREAM_CACHE: join(home, 'no-dev-cache'),
    // The venv step reuses this checkout's uv cache and the user's uv-managed Pythons.
    UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? join(repoDir, 'extensions/engine-hermes/.cache/uv-cache'),
    UV_PYTHON_INSTALL_DIR: process.env.UV_PYTHON_INSTALL_DIR ?? execFileSync('uv', ['python', 'dir'], { encoding: 'utf8' }).trim(),
  };
}
const cdpPort = await availablePort();
const model = createServer((request, response) => {
  if (request.headers.authorization !== 'Bearer scripted-key') {
    response.writeHead(401).end();
    return;
  }
  if (request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'scripted-model' }] }));
    return;
  }
  if (request.method === 'POST' && request.url === '/v1/chat/completions') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (!body.stream) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from your first bot.' }, finish_reason: 'stop' }] }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const delta of [{ role: 'assistant', content: '' }, { content: 'Hello from your first bot.' }, {}]) {
        response.write('data: ' + JSON.stringify({ id: 'scripted-completion', object: 'chat.completion.chunk',
          model: 'scripted-model', choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : 'stop' }] }) + '\n\n');
      }
      response.end('data: [DONE]\n\n');
    });
    return;
  }
  response.writeHead(404).end();
});
await new Promise((done) => model.listen(0, '127.0.0.1', done));
const modelPort = model.address().port;
const desktop = spawn(exe, [], {
  cwd: appDir, stdio: 'ignore', windowsHide: false,
  env: {
    ...process.env,
    NMH_DESKTOP_REPO_ROOT: repoDir,
    NMH_DESKTOP_DATA_DIR: join(home, 'state'),
    NMH_HERMES_HOME: join(home, 'hermes'),
    NMH_DESKTOP_STATUS_FILE: statusFile,
    WEBVIEW2_USER_DATA_FOLDER: join(home, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    ...installEnv,
  },
});
let view;
let status;
let passed = false;
try {
  status = await eventually(async () => JSON.parse(await readFile(statusFile, 'utf8')), 'desktop ready file');
  const base = `http://127.0.0.1:${status.port}`;
  const token = (await eventually(async () => (await readFile(join(home, 'state', 'desktop.token'), 'utf8')).trim(), 'desktop token'));
  const rpc = createORPCClient(new RPCLink({ url: base, headers: { authorization: `Bearer ${token}` } }));
  assert.equal(status.trayReady, true);
  assert.equal((await fetch(`${base}/onboarding/get`, { method: 'POST' })).status, 401, 'onboarding requires authentication');
  assert.equal((await rpc.onboarding.get()).completed, false);

  const onboardingStart = performance.now();
  const stepTimes = {};
  let stepStart = onboardingStart;
  const markStep = (name, limit = 120_000) => {
    const elapsed = performance.now() - stepStart;
    stepTimes[name] = Math.round(elapsed);
    assert.ok(elapsed < limit, `${name} step exceeded ${limit / 1000} seconds (${Math.round(elapsed)} ms)`);
    stepStart = performance.now();
    console.log(`P7-8_STEP ${name}=${Math.round(elapsed)}ms`);
  };
  view = await openWebview(cdpPort);
  await view.wait('!!document.querySelector("[data-testid=onboarding-wizard]")', 'first-run setup');
  await view.wait('!!document.querySelector("[data-testid=onboarding-workspace]")', 'workspace bootstrap');
  const initial = await view.evaluate(`(() => {
    window.__p78PageInstance = 'kept-through-setup';
    return { owner: document.querySelector('[data-testid=onboarding-owner]')?.textContent,
      workspace: document.querySelector('[data-testid=onboarding-workspace]')?.textContent,
      progress: document.querySelector('[data-testid=onboarding-progress]')?.textContent,
      stepTimer: document.querySelector('[data-testid=onboarding-step-timer]')?.textContent,
      totalTimer: document.querySelector('[data-testid=onboarding-total-timer]')?.textContent,
      timeOrigin: performance.timeOrigin };
  })()`);
  assert.equal(initial.owner, 'Desktop Owner');
  assert.equal(initial.workspace, 'Default Workspace');
  assert.match(initial.progress, /Step 1 of 5/);
  assert.match(initial.stepTimer, /This step \d+:\d+/);
  assert.match(initial.totalTimer, /Total \d+:\d+/);
  assert.equal((await rpc.onboarding.get()).workspaceName, initial.workspace);
  markStep('startup_workspace_owner');

  if (installMode) {
    // P7-16: the Extensions card offers Install Hermes instead of the upstream-cache error.
    await view.evaluate('document.querySelector("[data-testid=onboarding-skip]").click()');
    await view.wait('location.pathname === "/extensions" && !!document.querySelector("[data-testid=onboarding-reminder]")', 'setup skipped');
    assert.equal((await rpc.extensions.enable({ id: 'engine-hermes' })).status, 'running', 'engine-hermes runs in install mode');
    await view.wait('!!document.querySelector("[data-testid=extension-engine-hermes-install-start]")', 'Extensions card offers Install Hermes');
    const card = await view.evaluate('document.querySelector("[data-testid=extension-engine-hermes]").textContent');
    assert.doesNotMatch(card, /NMH_UPSTREAM_CACHE|upstream cache missing/i, 'no raw env-var error');
    assert.match(card, /Install Hermes/);
    // The super agent card offers its own install from the same panel, and says it needs Hermes first.
    assert.equal((await rpc.extensions.enable({ id: 'engine-superagent' })).status, 'running', 'engine-superagent runs in install mode');
    await view.wait('!!document.querySelector("[data-testid=extension-engine-superagent-install-start]") && !!document.querySelector("[data-testid=extension-engine-superagent-install-needs]")', 'Extensions card offers Install the super agent, after Hermes');
    const superagentCard = await view.evaluate('document.querySelector("[data-testid=extension-engine-superagent]").textContent');
    assert.doesNotMatch(superagentCard, /NMH_UPSTREAM_CACHE|nmh-upstream-cache/i, 'no raw env-var error');
    assert.match(superagentCard, /Install the super agent/);
    assert.match(superagentCard, /Install Hermes first/);
    await view.evaluate('document.querySelector("[data-testid=onboarding-reminder] button").click()');
    await view.wait('!!document.querySelector("[data-testid=onboarding-owner-next]")', 'setup resumed');
    markStep('extensions_card');
  }

  await view.evaluate('document.querySelector("[data-testid=onboarding-owner-next]").click()');
  await view.wait('!!document.querySelector("[data-testid=onboarding-provider-save]")', 'inline provider form');
  await view.field('[data-testid=onboarding-provider-id]', 'scripted');
  await view.field('[data-testid=onboarding-provider-url]', `http://127.0.0.1:${modelPort}/v1`);
  await view.field('[data-testid=onboarding-provider-key]', 'scripted-key');
  await view.evaluate('document.querySelector("[data-testid=onboarding-provider-save]").click()');
  await view.wait('!!document.querySelector("[data-testid=onboarding-provider] option[value=scripted]")', 'model provider created through UI');
  assert.equal((await rpc.x.models.providers.test({ id: 'scripted' })).ok, true);
  await view.field('[data-testid=onboarding-model]', 'scripted-model');
  await view.evaluate('document.querySelector("[data-testid=onboarding-model-next]").click()');
  await view.wait('!!document.querySelector("[data-testid=onboarding-bot-name]")', 'bot stage');
  assert.equal((await rpc.x.models.roles.get()).default.model, 'scripted-model');
  assert.equal((await rpc.x.models.roles.get()).default.providerId, 'scripted');
  markStep('provider_model');

  if (installMode) {
    // P7-16: the bot step offers the same install, and Create bot waits for it.
    await view.wait('!!document.querySelector("[data-testid=onboarding-hermes-install-start]")', 'bot step offers Install Hermes');
    assert.equal(await view.evaluate('(() => { const b = document.querySelector("[data-testid=onboarding-bot-create]"); return b.disabled || b.getAttribute("aria-disabled") === "true"; })()'), true, 'Create bot waits for Hermes');
    await view.evaluate('document.querySelector("[data-testid=onboarding-hermes-install-start]").click()');
    await view.wait('!!document.querySelector("[data-testid=onboarding-hermes-install-progress]")', 'install progress shown');
    await view.wait('!document.querySelector("[data-testid=onboarding-hermes-install]") && !document.querySelector("[role=status]")?.textContent?.includes("Checking Hermes")', 'Hermes installed from onboarding', 9000);
    assert.equal((await rpc.x['engine-hermes'].install.status()).state, 'ready');
    markStep('hermes_install', 900_000);
  }

  await view.evaluate('document.querySelector("[data-testid=onboarding-bot-create]").click()');
  await view.wait('!!document.querySelector("[data-testid=onboarding-created-bot]")', 'first bot created');
  assert.equal(await view.evaluate('document.querySelector("[data-testid=onboarding-created-bot]").textContent'), 'first-bot');
  assert.ok((await rpc.x['engine-hermes'].profiles.list()).profiles.some((profile) => profile.name === 'first-bot'));
  markStep('first_bot');

  await view.evaluate('document.querySelector("[data-testid=onboarding-channel-next]").click()');
  await view.wait('!!document.querySelector("[data-testid=onboarding-chat-message]")', 'chat stage without optional channel');
  markStep('optional_channel');
  await view.evaluate('document.querySelector("[data-testid=onboarding-chat-send]").click()');
  await view.wait('document.querySelector("[data-testid=onboarding-chat-reply]")?.textContent?.includes("Hello from your first bot.")', 'first scripted model reply');
  await view.wait('!!document.querySelector("[data-testid=onboarding-finish]")', 'first chat completed');
  assert.equal(await view.evaluate('window.__p78PageInstance'), 'kept-through-setup', 'onboarding reload detected');
  assert.equal(await view.evaluate('performance.timeOrigin'), initial.timeOrigin, 'onboarding page navigation detected');
  assert.match(await view.evaluate('document.querySelector("[data-testid=onboarding-progress]").textContent'), /Step 5 of 5/);
  markStep('first_chat_reply');

  await view.evaluate('document.querySelector("[data-testid=onboarding-finish]").click()');
  await view.wait('location.pathname === "/extensions" && !document.querySelector("[data-testid=onboarding-reminder]")', 'onboarding completed');
  assert.equal((await rpc.onboarding.get()).completed, true);
  const elapsedTotal = Math.round(performance.now() - onboardingStart);
  markStep('finish');
  // The one-time Hermes install (install mode) is outside the onboarding budget.
  const budgeted = elapsedTotal - (stepTimes.hermes_install ?? 0) - (stepTimes.extensions_card ?? 0);
  assert.ok(budgeted < 240_000, `Onboarding exceeded 4-minute machine budget (${budgeted} ms)`);
  if (installMode) {
    await view.wait('!!document.querySelector("[data-testid=extension-engine-hermes]") && !document.querySelector("[data-testid=extension-engine-hermes-install]")', 'Extensions card no longer offers an install');
    await view.wait('!!document.querySelector("[data-testid=extension-engine-superagent-install-start]") && !document.querySelector("[data-testid=extension-engine-superagent-install-needs]")', 'super agent no longer waits for Hermes');
    // The Inbox while the super agent is not installed: an install offer, Ask disabled, and a steady connection
    // (no reconnect loop against the missing Inbox routes).
    await view.evaluate('document.querySelector("a[href^=\'/inbox\']").click()');
    await view.wait('location.pathname === "/inbox" && !!document.querySelector("[data-testid=inbox-superagent-install-start]")', 'Inbox offers Install the super agent');
    await view.wait('document.querySelector(".connection")?.textContent === "Live"', 'Inbox connection live');
    await sleep(2000);
    const notInstalled = await view.evaluate(`({ connection: document.querySelector('.connection')?.textContent,
      prompt: document.querySelector('#inbox-prompt').disabled, text: document.querySelector('[data-testid=inbox-not-installed]')?.textContent,
      disabledNotice: !!document.querySelector('[data-testid=inbox-disabled]') })`);
    assert.equal(notInstalled.connection, 'Live', 'no reconnect loop while the super agent is not installed');
    assert.equal(notInstalled.prompt, true, 'Ask is disabled until the super agent is installed');
    assert.match(notInstalled.text, /not installed/);
    assert.equal(notInstalled.disabledNotice, false);
    await assert.rejects(rpc.inbox.list(), /not installed/, 'the Gateway says not installed, not disabled');
    // Installing from the Inbox brings the Inbox up in place.
    await view.evaluate('document.querySelector("[data-testid=inbox-superagent-install-start]").click()');
    await view.wait('!document.querySelector("[data-testid=inbox-not-installed]") && !document.querySelector("#inbox-prompt").disabled && document.querySelector(".connection")?.textContent === "Live"', 'Inbox ready after installing the super agent', 1200);
    assert.equal((await rpc.x['engine-superagent'].install.status()).state, 'ready');
    assert.deepEqual(await rpc.inbox.list(), []);
  }
  console.log('P7-8_TIMES ' + JSON.stringify({ ...stepTimes, total: elapsedTotal, max_allowed: 240000 }));

  closeWindow(desktop.pid);
  await eventually(() => !alive(desktop.pid), 'desktop clean exit', 450);
  await eventually(async () => {
    try { await fetch(`${base}/health`); return false; } catch { return true; }
  }, 'gateway clean exit', 450);
  console.log((installMode ? 'P7-8 PASS hermes=installed-from-onboarding extensions_card=install-button superagent_card=install-button+needs-hermes inbox=not-installed+no-reconnect+installed ' : 'P7-8 PASS ') + 'build=true WebView2=true workspace=true owner=true model=scripted bot=true channel=optional chat=reply reload=false exit=clean');
  passed = true;
} finally {
  view?.close();
  if (alive(desktop.pid)) spawnSync('taskkill.exe', ['/PID', String(desktop.pid), '/T', '/F'], { windowsHide: true });
  if (status?.gatewayPid && alive(status.gatewayPid)) spawnSync('taskkill.exe', ['/PID', String(status.gatewayPid), '/T', '/F'], { windowsHide: true });
  await new Promise((done) => model.close(done));
  if (fixtureServer) await new Promise((done) => fixtureServer.close(done));
  if (status?.gatewayPid) await eventually(() => !alive(status.gatewayPid), 'gateway exit before cleanup', 100).catch(() => {});
  // A cleanup error (e.g. EBUSY) must not replace a real failure, but on a passing run it is a leak and fails the test.
  await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }).catch((error) => {
    if (passed) throw error;
    console.warn(`P7-8 cleanup warning (test already failed): ${error.message}`);
  });
}
