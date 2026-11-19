import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
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
    wait: async (expression, label) => {
      try {
        return await eventually(() => evaluate(expression), label);
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

const home = await mkdtemp(join(tmpdir(), 'nmh-p1-8-'));
const statusFile = join(home, 'ready.json');
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
  },
});
let view;
let status;
try {
  status = await eventually(async () => JSON.parse(await readFile(statusFile, 'utf8')), 'desktop ready file');
  const base = `http://127.0.0.1:${status.port}`;
  const token = (await eventually(async () => (await readFile(join(home, 'state', 'desktop.token'), 'utf8')).trim(), 'desktop token'));
  const rpc = createORPCClient(new RPCLink({ url: base, headers: { authorization: `Bearer ${token}` } }));
  assert.equal(status.trayReady, true);
  assert.equal((await fetch(`${base}/onboarding/get`, { method: 'POST' })).status, 401, 'onboarding requires authentication');
  assert.equal((await rpc.onboarding.get()).completed, false);

  view = await openWebview(cdpPort);
  await view.wait('!!document.querySelector("[data-testid=onboarding-wizard]")', 'first-run setup');
  await view.wait('!!document.querySelector("[data-testid=onboarding-owner]")', 'bootstrapped owner');
  await view.evaluate('document.querySelector("[data-testid=onboarding-skip]").click()');
  await view.wait('!!document.querySelector("[data-testid=onboarding-reminder]")', 'reminder after skip');
  assert.equal((await rpc.onboarding.get()).completed, false, 'skipping keeps setup incomplete');

  assert.equal((await rpc.extensions.enable({ id: 'models' })).status, 'running');
  await rpc.x.models.providers.put({
    id: 'scripted', kind: 'openai-compatible', name: 'Scripted local model',
    baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKey: 'scripted-key',
  });
  assert.equal((await rpc.x.models.providers.test({ id: 'scripted' })).ok, true);

  await view.evaluate('document.querySelector("[data-testid=onboarding-reminder] button").click()');
  await view.wait('!!document.querySelector("[data-testid=onboarding-owner-next]")', 'resume setup');
  await view.evaluate('document.querySelector("[data-testid=onboarding-owner-next]").click()');
  await view.wait('!!document.querySelector("[data-testid=onboarding-provider] option[value=scripted]")', 'scripted provider option');
  await view.field('[data-testid=onboarding-provider]', 'scripted');
  await view.field('[data-testid=onboarding-model]', 'scripted-model');
  await view.evaluate('document.querySelector("[data-testid=onboarding-model-next]").click()');
  await view.wait('!!document.querySelector("[data-testid=onboarding-bot-name]")', 'bot stage');
  assert.equal((await rpc.x.models.roles.get()).default.model, 'scripted-model');

  await view.field('[data-testid=onboarding-bot-name]', 'first_helper');
  await view.evaluate('document.querySelector("[data-testid=onboarding-bot-create]").click()');
  await view.wait('!!document.querySelector("[data-testid=onboarding-created-bot]")', 'bot created');
  assert.equal(await view.evaluate('document.querySelector("[data-testid=onboarding-created-bot]").textContent'), 'first_helper');
  await view.evaluate('document.querySelector("[data-testid=onboarding-channel-next]").click()');
  await view.wait('!!document.querySelector("[data-testid=onboarding-chat-message]")', 'first chat stage');
  await view.evaluate('document.querySelector("[data-testid=onboarding-chat-send]").click()');
  await view.wait('document.querySelector("[data-testid=onboarding-chat-reply]")?.textContent?.includes("Hello from your first bot.")', 'scripted first reply');
  await view.wait('!!document.querySelector("[data-testid=onboarding-finish]")', 'chat completed');
  await view.evaluate('document.querySelector("[data-testid=onboarding-finish]").click()');
  await view.wait('location.pathname === "/extensions" && !document.querySelector("[data-testid=onboarding-reminder]")', 'setup completed');
  const completed = await rpc.onboarding.get();
  assert.equal(completed.completed, true);
  assert.ok(completed.completedAt);
  assert.equal(completed.mode, 'desktop');
  assert.equal(JSON.parse(await readFile(join(home, 'state', 'onboarding.json'), 'utf8')).completedAt, completed.completedAt);

  closeWindow(desktop.pid);
  await eventually(() => !alive(desktop.pid), 'desktop clean exit', 450);
  await eventually(async () => {
    try { await fetch(`${base}/health`); return false; } catch { return true; }
  }, 'gateway clean exit', 450);
  console.log('P1-8 PASS build=true WebView2=true auth=true owner=true skip=true resume=true model=scripted bot=true channel=optional persisted=true exit=clean');
} finally {
  view?.close();
  if (alive(desktop.pid)) spawnSync('taskkill.exe', ['/PID', String(desktop.pid), '/T', '/F'], { windowsHide: true });
  if (status?.gatewayPid && alive(status.gatewayPid)) spawnSync('taskkill.exe', ['/PID', String(status.gatewayPid), '/T', '/F'], { windowsHide: true });
  await new Promise((done) => model.close(done));
  await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
}
