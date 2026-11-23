import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as httpServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createORPCClient } from '@orpc/client';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import { startGateway } from '../../gateway/src/server.ts';
import { HeadlessChromeProvider } from '../../../extensions/computer-headless-chrome/src/index.ts';
import { requireUpstreamCache } from '../../../tests/upstream-cache.mjs';
requireUpstreamCache('apps/neo-app/test/p3-2.mjs', ['hermes-agent']);

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '../..');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}

async function freePort() {
  const server = netServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function eventually(check, description, ms = 45000) {
  const deadline = Date.now() + ms;
  let lastError;
  while (Date.now() < deadline) {
    try { if (await check()) return; }
    catch (error) { lastError = error; }
    await pause(100);
  }
  throw new Error(`${description} timed out: ${String(lastError ?? '')}`);
}

async function fixtureServer() {
  const server = httpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    const body = req.url === '/stage'
      ? '<button id="change" onclick="document.body.style.background=\'#14b85b\';this.dataset.changed=\'yes\'">Change screen</button>'
      : '<a id="next" href="/stage">Open second page</a>';
    res.end(`<!doctype html><html><style>body{margin:0;background:#ae2424}a,button{position:absolute;left:60px;top:160px;width:260px;height:100px;font-size:24px}</style>${body}</html>`);
  });
  return { server, port: await listen(server) };
}

async function scriptedModel() {
  let calls = 0;
  const server = httpServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
      return;
    }
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const messages = input.messages ?? [];
    const isRun = messages.some((message) => message.role === 'user' && JSON.stringify(message.content).includes('trigger_chrome')) &&
      !messages.some((message) => message.role === 'system' && JSON.stringify(message.content).includes('You name chat sessions'));
    const toolCount = messages.filter((message) => message.role === 'tool').length;
    const useTool = isRun && toolCount < 2;
    const tool = {
      id: `chrome-call-${toolCount}`, type: 'function', function: {
        name: 'tool_call', arguments: JSON.stringify({ calls: [{
          name: 'computer_use', arguments: { action: 'click', coordinate: [100, 200], capture_after: true },
        }] }),
      },
    };
    if (useTool) calls++;
    const message = useTool
      ? { role: 'assistant', content: 'Using the computer', tool_calls: [tool] }
      : { role: 'assistant', content: 'Chrome run complete' };
    const finish = useTool ? 'tool_calls' : 'stop';
    res.writeHead(200, { 'content-type': input.stream ? 'text/event-stream' : 'application/json' });
    if (!input.stream) {
      res.end(JSON.stringify({ id: 'neo-chrome', object: 'chat.completion', model: 'fake-model', choices: [{ index: 0, message, finish_reason: finish }] }));
      return;
    }
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({
      id: 'neo-chrome', object: 'chat.completion.chunk', model: 'fake-model', created: 1,
      choices: [{ index: 0, delta, finish_reason }],
    }) + '\n\n');
    emit({ role: 'assistant', content: '' });
    if (useTool) emit({ tool_calls: [{ index: 0, ...tool }] });
    else emit({ content: 'Chrome run complete' });
    emit({}, finish);
    res.end('data: [DONE]\n\n');
  });
  return { server, port: await listen(server), get calls() { return calls; } };
}

class CDP {
  // The provider hands out an in-process CDP channel (pipe transport, SEC-06), not a URL.
  constructor(channel) {
    this.channel = channel;
  }
  static async open(details) {
    const cdp = new CDP(details);
    cdp.session = (await cdp.send('Target.attachToTarget', { targetId: details.targetId, flatten: true })).sessionId;
    await cdp.send('Page.enable', {}, cdp.session);
    await cdp.send('Runtime.enable', {}, cdp.session);
    return cdp;
  }
  send(method, params = {}, sessionId) { return this.channel.send(method, params, sessionId); }
  async navigate(url) { await this.send('Page.navigate', { url }, this.session); }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true }, this.session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  close() { /* the provider owns the pipe; release() closes it */ }
}

async function browserView(provider, id, url) {
  const browser = await CDP.open(provider.browser(id));
  await browser.navigate(url);
  await eventually(() => browser.evaluate('document.readyState === "complete"'), 'viewer page loading');
  return browser;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function verifyStartupSize() {
  const html = await readFile(join(app, 'dist', 'index.html'), 'utf8');
  const assets = new Set();
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*["']([^"']+)["']/g)]
      .map(([, key, value]) => [key.toLowerCase(), value]));
    if (tag.startsWith('<script') && attrs.type === 'module' && attrs.src) assets.add(attrs.src);
    if (tag.startsWith('<link') && attrs.rel === 'modulepreload' && attrs.href) assets.add(attrs.href);
  }
  assert.ok(assets.size, 'Startup JavaScript entry exists');
  const total = (await Promise.all([...assets].map(async (asset) =>
    gzipSync(await readFile(join(app, 'dist', asset.replace(/^\//, '')))).length))).reduce((a, b) => a + b, 0);
  assert.ok(total <= 300 * 1024, `Startup JS too large: ${total}`);
  console.log(`P3-2_STARTUP_JS PASS gzip=${total}`);
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function main() {
  const temp = await mkdtemp(join(tmpdir(), 'nmh-p3-2-'));
  const fixture = await fixtureServer();
  const model = await scriptedModel();
  const previousHome = process.env.NMH_HERMES_HOME;
  const previousModel = process.env.NMH_HERMES_MODEL_URL;
  process.env.NMH_HERMES_HOME = join(temp, 'hermes');
  process.env.NMH_HERMES_MODEL_URL = `http://127.0.0.1:${model.port}/v1`;
  let gateway, preview, viewer;
  const provider = new HeadlessChromeProvider();
  const viewerProvider = new HeadlessChromeProvider();
  try {
    gateway = await startGateway({ databaseFile: join(temp, 'state.sqlite'), extensionsDir: join(repo, 'extensions'), mode: 'desktop', dataDir: temp });
    const token = gateway.desktopToken;
    const base = `http://127.0.0.1:${gateway.port}`;
    const rpc = createORPCClient(new HttpLink({ url: base, headers: { authorization: `Bearer ${token}` } }));
    const extension = await rpc.extensions.enable({ id: 'computer-headless-chrome' });
    assert.equal(extension.status, 'running', JSON.stringify(extension));
    assert.equal((await rpc.extensions.enable({ id: 'engine-hermes' })).status, 'running');
    assert.equal((await rpc.extensions.enable({ id: 'sample-ts' })).status, 'running');

    // Exercise the installed extension through its public gateway entry point.
    await rpc.computers.attach({ providerId: 'computer-headless-chrome', target: 'extension-smoke' });
    assert.ok((await rpc.computers.capture({ id: 'extension-smoke' })).png.length > 50);
    assert.equal((await rpc.computers.release({ id: 'extension-smoke' })).released, true);

    // Share the exact provider implementation with the gateway while retaining its PID/CDP handle for verification.
    const unregister = gateway.computers.registerProvider('chrome-test', provider);
    await rpc.computers.attach({ providerId: 'chrome-test', target: 'shared-chrome' });
    const pid = provider.pid('shared-chrome');
    assert.ok(pid && isAlive(pid));
    const target = await browserView(provider, 'shared-chrome', `http://127.0.0.1:${fixture.port}/`);
    await eventually(() => target.evaluate('!!document.getElementById("next")'), 'fixture navigation link');
    const initial = (await rpc.computers.capture({ id: 'shared-chrome' })).png;

    await rpc.x['engine-hermes'].profiles.create({ name: 'chrome_bot' });
    await rpc.computers.assign({ engine: 'hermes', targetId: 'chrome_bot', computerId: 'shared-chrome' });
    assert.deepEqual((await rpc.computers.list()).find((computer) => computer.id === 'shared-chrome').assignments,
      [{ engine: 'hermes', targetId: 'chrome_bot' }]);

    // Render the actual Computers route in an independently isolated Chrome.
    const port = await freePort();
    preview = spawn(process.execPath, [join(app, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      { cwd: app, stdio: 'ignore', windowsHide: true });
    await eventually(async () => (await fetch(`http://127.0.0.1:${port}/computers`)).ok, 'Vite preview');
    await viewerProvider.attach('viewer');
    viewer = await browserView(viewerProvider, 'viewer', `http://127.0.0.1:${port}/computers?gateway=${encodeURIComponent(base)}&token=${encodeURIComponent(token)}`);
    await eventually(() => viewer.evaluate('!!document.querySelector("[data-testid=computers-page]")'), 'lazy Computers route');
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=computer-frame]")?.naturalWidth > 0'), 'live screenshot');
    const visibleInitial = await viewer.evaluate('document.querySelector("[data-testid=computer-frame]").src');
    assert.ok(visibleInitial.startsWith('data:image/png;base64,'));

    const run = await rpc.x['engine-hermes'].runs.start({ profile: 'chrome_bot', input: 'trigger_chrome' });
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', ['bearer.' + token]);
    const stream = createORPCClient(new WebSocketLink({ websocket: socket }));
    const events = [];
    let runTimeout;
    try {
      await Promise.race([(async () => {
        for await (const event of await stream.x['engine-hermes'].runs.events({ profile: 'chrome_bot', runId: run.run_id })) {
          events.push(event);
          if (event.type === 'approval.request') await rpc.x['engine-hermes'].runs.approve({ profile: 'chrome_bot', runId: run.run_id, choice: 'once' });
          if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) break;
        }
      })(), new Promise((_, reject) => {
        runTimeout = setTimeout(() => reject(new Error('Hermes run timed out; events=' + JSON.stringify(events.map((event) => event.type)))), 120000);
      })]);
    } finally { clearTimeout(runTimeout); socket.close(); }
    assert.ok(events.some((event) => event.type === 'run.completed'), JSON.stringify(events.slice(-10)));
    assert.ok(model.calls >= 2, 'Scripted model performed navigation and button click');
    await eventually(() => target.evaluate('document.getElementById("change")?.dataset.changed === "yes"'), 'agent clicked the destination button');
    const changed = (await rpc.computers.capture({ id: 'shared-chrome' })).png;
    assert.notEqual(changed, initial, 'screen PNG changed after agent navigation/click');
    await eventually(() => viewer.evaluate(`document.querySelector('[data-testid=computer-frame]')?.src === ${JSON.stringify('data:image/png;base64,' + changed)}`), 'viewer shows updated PNG');
    const acting = [];
    const abort = new AbortController();
    for await (const event of gateway.kernel.events.subscribe(0, abort.signal)) {
      if (event.type === 'computer.acting' && event.computerId === 'shared-chrome') acting.push(event);
      if (acting.length >= 8) { abort.abort(); break; }
    }
    assert.deepEqual(acting.filter((event) => event.active).map((event) => event.action),
      ['click', 'capture', 'click', 'capture'], 'agent actions are visibly announced on the event bus');

    const binding = JSON.parse(await readFile(join(temp, 'hermes/profiles/chrome_bot/plugins/neo_vnc/binding.json'), 'utf8'));
    const agentAction = () => fetch(binding.endpoint, {
      method: 'POST', headers: { authorization: `Bearer ${binding.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'click', x: 100, y: 200 }),
    });
    await viewer.evaluate('document.querySelector("[data-testid=computer-lease]").click()');
    await eventually(async () => (await rpc.computers.list())[0]?.holder === 'human', 'human takeover');
    assert.equal((await agentAction()).status, 403, 'human lease blocks agent clicks');
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=computer-lease]")?.textContent?.includes("Hand back") && !(document.querySelector("[data-testid=computer-lease]")?.disabled || document.querySelector("[data-testid=computer-lease]")?.getAttribute("aria-disabled") === "true")'), 'handback control ready');
    await viewer.evaluate('document.querySelector("[data-testid=computer-lease]").click()');
    await eventually(async () => (await rpc.computers.list())[0]?.holder === 'agent', 'hand back');
    assert.equal((await agentAction()).status, 200, 'handback restores input');
    await eventually(() => viewer.evaluate('!(document.querySelector("[data-testid=stop-all-agents]")?.disabled || document.querySelector("[data-testid=stop-all-agents]")?.getAttribute("aria-disabled") === "true")'), 'stop control ready');
    await viewer.evaluate('document.querySelector("[data-testid=stop-all-agents]").click()');
    await eventually(async () => (await rpc.computers.state()).engaged, 'global kill switch');
    assert.equal((await agentAction()).status, 403, 'kill switch blocks input');
    assert.ok(events.some((event) => event.type === 'run.completed'));
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=stop-all-agents]")?.textContent?.includes("Resume agents") && !!document.querySelector("[data-testid=computer-release]") && !(document.querySelector("[data-testid=computer-release]")?.disabled || document.querySelector("[data-testid=computer-release]")?.getAttribute("aria-disabled") === "true")'), 'release control ready');
    await viewer.evaluate('document.querySelector("[data-testid=computer-release]").click()');
    await eventually(async () => !(await rpc.computers.list()).some((computer) => computer.id === 'shared-chrome'), 'release');
    await eventually(() => !isAlive(pid), 'Chrome PID exits', 15000);
    assert.equal((await fetch(base + '/x/sample-ts/hello', { headers: { authorization: `Bearer ${token}` } })).status, 200);
    await unregister();
    target.close();
    console.log('P3-2_GATEWAY_UI PASS chrome=true Hermes=navigate+click frames=changed lease=403 handback=200 kill=403 pid=gone sample=healthy');
  } finally {
    viewer?.close();
    await viewerProvider.release('viewer');
    if (preview?.pid) {
      if (process.platform === 'win32') spawnSync(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe'), ['/PID', String(preview.pid), '/T', '/F'], { windowsHide: true });
      else preview.kill('SIGKILL');
    }
    await provider.release('shared-chrome');
    await gateway?.close();
    await closeServer(model.server);
    await closeServer(fixture.server);
    if (previousHome === undefined) delete process.env.NMH_HERMES_HOME;
    else process.env.NMH_HERMES_HOME = previousHome;
    if (previousModel === undefined) delete process.env.NMH_HERMES_MODEL_URL;
    else process.env.NMH_HERMES_MODEL_URL = previousModel;
    await rm(temp, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 });
  }
}

// Always build the current tree; never preview or measure a stale dist.
const build = spawnSync(process.execPath, [join(app, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: app, stdio: 'inherit', windowsHide: true });
assert.equal(build.status, 0, 'Vite build failed');
await verifyStartupSize();
await main();
console.log('P3-2_EXIT PASS');
