import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '../..');
const chromePath = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const terminate = (child) => {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill();
};

async function portOf(server) {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function ready(url) {
  for (let retry = 0; retry < 120; retry++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not started */ }
    await sleep(100);
  }
  throw new Error(`Preview unavailable at ${url}`);
}

async function gateway(home) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: join(repo, 'apps', 'gateway'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    env: { ...process.env, NMH_DB_PATH: join(home, 'database.sqlite'), NMH_HERMES_HOME: join(home, 'hermes'),
      NMH_EXTENSIONS_DIR: join(repo, 'extensions'), NMH_PORT: '0', NEO_MODE: 'desktop', NEO_PRINT_DESKTOP_TOKEN: '1' },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-10000); });
  let token = '';
  const port = await Promise.race([
    new Promise((done, reject) => {
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        if (line.startsWith('NEO_DESKTOP_TOKEN ')) token = line.slice(18).trim();
        if (line.startsWith('GATEWAY_READY ')) {
          lines.close();
          done(JSON.parse(line.slice(14)).port);
        }
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Gateway exited ${code}: ${stderr.slice(-600)}`)));
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Gateway startup timed out: ${stderr}`)), 30000)),
  ]);
  assert.ok(token.length > 16, 'Desktop authentication token missing');
  return { port, token, child, logs: () => stderr };
}

async function chrome(profile) {
  const child = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'],
  { stdio: 'ignore', windowsHide: true });
  let port;
  for (let retry = 0; retry < 120; retry++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { if (child.exitCode !== null) throw new Error(`Chrome exited ${child.exitCode}`); await sleep(100); }
  }
  assert.ok(port, 'Chrome CDP port missing');
  const details = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const socket = new WebSocket(details.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  let next = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!pending.has(message.id)) return;
    pending.get(message.id)(message);
    pending.delete(message.id);
  };
  const send = (method, params = {}, sessionId) => new Promise((done, reject) => {
    const id = ++next;
    pending.set(id, (message) => message.error ? reject(new Error(message.error.message)) : done(message.result));
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return { send, close: () => { socket.close(); terminate(child); } };
}

async function page(browser, url) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('Page.enable', {}, sessionId);
  await browser.send('Page.navigate', { url }, sessionId);
  const evaluate = async (expression) => {
    const result = await browser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(`Browser exception: ${result.exceptionDetails.text}`);
    return result.result.value;
  };
  const eventually = async (expression, label) => {
    for (let retry = 0; retry < 250; retry++) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw new Error(`${label} timed out. DOM=${String(await evaluate('document.body?.innerText')).slice(0, 550)}`);
  };
  const field = async (selector, value) => evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('Missing field');
    const prototype = element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  })()`);
  return { evaluate, eventually, field, close: () => browser.send('Target.closeTarget', { targetId }) };
}

// Compile the lazy route before launching a browser or starting gateway auth.
execFileSync(process.execPath, [join(app, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: app, stdio: 'pipe' });

const temporary = await mkdtemp(join(tmpdir(), 'nmh-p2-6-'));
const secret = 'P2_6_UI_KEY_NEVER_PRINT';
let hits = 0;
const fake = createServer((request, response) => {
  hits++;
  if (request.url !== '/v1/models' || request.headers.authorization !== `Bearer ${secret}`) {
    response.writeHead(401).end();
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
});
const fakePort = await portOf(fake);
let server;
let preview;
let browser;
try {
  server = await gateway(temporary);
  const base = `http://127.0.0.1:${server.port}`;
  assert.equal((await fetch(base + '/x/models/providers/list')).status, 401, 'models endpoints require auth');
  const client = createORPCClient(new RPCLink({ url: base, headers: { authorization: `Bearer ${server.token}` } }));
  assert.equal((await client.extensions.enable({ id: 'models' })).status, 'running');

  const probe = createServer();
  const previewPort = await portOf(probe);
  await new Promise((done) => probe.close(done));
  preview = spawn(process.execPath, [join(app, 'node_modules', 'vite', 'bin', 'vite.js'),
    'preview', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort'],
  { cwd: app, stdio: 'ignore', windowsHide: true });
  await ready(`http://127.0.0.1:${previewPort}/settings`);

  browser = await chrome(join(temporary, 'chrome'));
  const view = await page(browser, `http://127.0.0.1:${previewPort}/settings?gateway=${encodeURIComponent(base)}&token=${encodeURIComponent(server.token)}`);
  try {
    await view.eventually('!!document.querySelector("a[href^=\'/settings/models\']")', 'Settings Models link');
    await view.evaluate('document.querySelector("a[href^=\'/settings/models\']").click()');
    await view.eventually('!!document.querySelector("[data-testid=settings-models]")', 'lazy Models route');
    const save = '[data-testid=models-save-provider]';
    assert.equal(await view.evaluate(`document.querySelector('${save}').getAttribute('aria-disabled')`), 'true');
    await view.field('[data-testid=models-provider-id]', 'fake-b');
    await view.field('[data-testid=models-provider-url]', `http://127.0.0.1:${fakePort}/v1`);
    await view.field('[data-testid=models-provider-key]', secret);
    await view.eventually(`document.querySelector('${save}').getAttribute('aria-disabled') !== 'true'`, 'save provider enabled');
    await view.evaluate(`document.querySelector('${save}').click()`);
    await view.eventually('!!document.querySelector("[data-testid=models-test-fake-b]")', 'provider saved');
    assert.equal(await view.evaluate('document.querySelector("[data-testid=models-provider-key]").value'), '', 'key field must clear');
    await view.evaluate('document.querySelector("[data-testid=models-test-fake-b]").click()');
    await view.eventually('document.body.innerText.includes("fake-b connected (1 models)")', 'tested connection');
    assert.ok(hits > 0, 'test connection hit fake OpenAI server');

    await view.field('[data-testid=models-role-coding-provider]', 'fake-b');
    await view.field('[data-testid=models-role-coding-model]', 'fake-model');
    await view.eventually('document.querySelector("[data-testid=models-save-role-coding]").getAttribute("aria-disabled") !== "true"', 'role button enabled');
    await view.evaluate('document.querySelector("[data-testid=models-save-role-coding]").click()');
    await view.eventually('document.body.innerText.includes("Saved coding role")', 'coding role persisted');
    await view.field('[data-testid=models-bot-profile]', 'bot1');
    await view.field('[data-testid=models-override-provider]', 'fake-b');
    await view.field('[data-testid=models-override-model]', 'fake-model');
    await view.eventually('document.querySelector("[data-testid=models-save-override]").getAttribute("aria-disabled") !== "true"', 'override button enabled');
    await view.evaluate('document.querySelector("[data-testid=models-save-override]").click()');
    await view.eventually('document.body.innerText.includes("Saved override for bot1")', 'override persisted');
    assert.equal((await client.x.models.roles.get()).coding.providerId, 'fake-b');
    assert.equal((await client.x.models.override.get({ profile: 'bot1' })).selection.providerId, 'fake-b');
    assert.ok(!(JSON.stringify(await client.x.models.providers.list())).includes(secret), 'secret exposed in provider listing');
    assert.ok(!server.logs().includes(secret), 'secret exposed in gateway stderr');
    console.log('P2-6_UI PASS build=true auth=true lazy=true aria-disabled=true providers=true connection=true roles=true override=true key=write-only');
  } finally { await view.close(); }
} finally {
  browser?.close();
  terminate(preview);
  if (server?.child.connected) server.child.send('shutdown');
  if (server?.child.exitCode === null) {
    await Promise.race([new Promise((done) => server.child.once('exit', done)), sleep(8000)]);
    terminate(server.child);
  }
  fake.closeAllConnections();
  await new Promise((done) => fake.close(done));
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
