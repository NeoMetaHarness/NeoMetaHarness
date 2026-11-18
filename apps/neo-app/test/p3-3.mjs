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
import { HermesRuntime } from '../../../extensions/engine-hermes/src/runtime.ts';

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
    const latestRun = messages.findLastIndex((message) => message.role === 'user' && JSON.stringify(message.content).includes('trigger_chrome'));
    const isRun = latestRun !== -1 &&
      !messages.some((message) => message.role === 'system' && JSON.stringify(message.content).includes('You name chat sessions'));
    const toolCount = messages.slice(latestRun + 1).filter((message) => message.role === 'tool').length;
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
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.next = 0;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data.toString());
      if (!message.id) return;
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (waiter) message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
    });
  }
  static async open(details) {
    const socket = new WebSocket(details.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    const cdp = new CDP(socket);
    cdp.session = (await cdp.send('Target.attachToTarget', { targetId: details.targetId, flatten: true })).sessionId;
    await cdp.send('Page.enable', {}, cdp.session);
    await cdp.send('Runtime.enable', {}, cdp.session);
    return cdp;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async navigate(url) { await this.send('Page.navigate', { url }, this.session); }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true }, this.session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.socket.close(); }
}

async function browserView(provider, id, url) {
  const browser = await CDP.open(provider.browser(id));
  await browser.navigate(url);
  await eventually(() => browser.evaluate('document.readyState === "complete"'), 'viewer page loading');
  return browser;
}

async function hermesRun(rpc, base, token, profile) {
  const run = await rpc.x['engine-hermes'].runs.start({ profile, input: 'trigger_chrome' });
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', ['bearer.' + token]);
  const stream = createORPCClient(new WebSocketLink({ websocket: socket }));
  const events = [];
  let runTimeout;
  try {
    await Promise.race([(async () => {
      for await (const event of await stream.x['engine-hermes'].runs.events({ profile, runId: run.run_id })) {
        events.push(event);
        if (event.type === 'approval.request') {
          await rpc.x['engine-hermes'].runs.approve({ profile, runId: run.run_id, choice: 'once' });
        }
        if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) break;
      }
    })(), new Promise((_, reject) => {
      runTimeout = setTimeout(() => reject(new Error('Hermes run timed out: ' + JSON.stringify(events.slice(-8)))), 120000);
    })]);
  } finally { clearTimeout(runTimeout); socket.close(); }
  return events;
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
  const originalStop = HermesRuntime.prototype.stopProfile;
  const profileStops = [];
  HermesRuntime.prototype.stopProfile = function (...args) {
    profileStops.push(args[0]);
    return originalStop.apply(this, args);
  };
  const temp = await mkdtemp(join(tmpdir(), 'nmh-p3-3-'));
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
    const unregister = gateway.computers.registerProvider('computer-headless-chrome', provider);
    assert.equal((await rpc.extensions.enable({ id: 'computer-local-sandbox' })).status, 'running');
    assert.equal((await rpc.extensions.enable({ id: 'engine-hermes' })).status, 'running');
    assert.equal((await rpc.extensions.enable({ id: 'sample-ts' })).status, 'running');

    // Register the A extension's provider implementation with its canonical ID
    // so the test can control its Chrome target through CDP.
    await rpc.computers.attach({ providerId: 'computer-headless-chrome', target: 'shared-chrome' });
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

    const events = await hermesRun(rpc, base, token, 'chrome_bot');
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

    const stopsBeforeSwap = profileStops.length;
    const previousBinding = JSON.parse(await readFile(join(temp, 'hermes/profiles/chrome_bot/plugins/neo_vnc/binding.json'), 'utf8'));
    const agentAction = (binding) => fetch(binding.endpoint, {
      method: 'POST', headers: { authorization: `Bearer ${binding.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'click', x: 100, y: 200 }),
    });
    const bComputer = await rpc.computers.attach({ providerId: 'computer-local-sandbox', target: 'sandbox-b' });
    assert.equal(bComputer.providerId, 'computer-local-sandbox');
    assert.ok((await rpc.computers.capture({ id: 'sandbox-b' })).png.length > 50);
    await rpc.computers.assign({ engine: 'hermes', targetId: 'chrome_bot', computerId: 'sandbox-b' });
    assert.equal(gateway.computers.binding('hermes', 'chrome_bot').computerId, 'sandbox-b');
    assert.equal((await agentAction(previousBinding)).status, 403, 'old A capability revoked on swap');
    await eventually(async () => (await rpc.computers.list()).find(({ id }) => id === 'sandbox-b')?.assignments.some(({ targetId }) => targetId === 'chrome_bot'), 'B assignment');
    await eventually(() => viewer.evaluate('!!document.querySelector("[data-testid=computer-sandbox-b]")'), 'B appears on Computers page');
    await viewer.evaluate('document.querySelector("[data-testid=computer-sandbox-b]").click()');
    await eventually(() => viewer.evaluate('document.querySelector(".computers-assignments ul")?.textContent?.includes("chrome_bot")'), 'live Computers page assignment changes');
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=computer-frame]")?.naturalWidth > 0'), 'B screenshot visible');

    const secondEvents = await hermesRun(rpc, base, token, 'chrome_bot');
    assert.ok(secondEvents.some(({ type }) => type === 'run.completed'), JSON.stringify(secondEvents.slice(-10)));
    assert.equal(profileStops.length, stopsBeforeSwap, 'swapping computers keeps the Hermes bot process running');
    const bActions = [];
    const bAbort = new AbortController();
    for await (const event of gateway.kernel.events.subscribe(0, bAbort.signal)) {
      if (event.type === 'computer.acting' && event.computerId === 'sandbox-b' && event.active) bActions.push(event.action);
      if (bActions.length >= 4) { bAbort.abort(); break; }
    }
    assert.deepEqual(bActions, ['click', 'capture', 'click', 'capture'], 'same Hermes bot acted on B');
    const binding = JSON.parse(await readFile(join(temp, 'hermes/profiles/chrome_bot/plugins/neo_vnc/binding.json'), 'utf8'));
    assert.equal(binding.computerId, 'sandbox-b', 'Hermes profile binding refreshed without bot restart');
    assert.notEqual(previousBinding.token, binding.token);

    await viewer.evaluate('document.querySelector("[data-testid=computer-lease]").click()');
    await eventually(async () => (await rpc.computers.list()).find(({ id }) => id === 'sandbox-b')?.holder === 'human', 'human takeover');
    assert.equal((await agentAction(binding)).status, 403, 'human lease blocks agent clicks on B');
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=computer-lease]")?.textContent?.includes("Hand back") && !(document.querySelector("[data-testid=computer-lease]")?.disabled || document.querySelector("[data-testid=computer-lease]")?.getAttribute("aria-disabled") === "true")'), 'handback control ready');
    await viewer.evaluate('document.querySelector("[data-testid=computer-lease]").click()');
    await eventually(async () => (await rpc.computers.list()).find(({ id }) => id === 'sandbox-b')?.holder === 'agent', 'hand back');
    assert.equal((await agentAction(binding)).status, 200, 'handback restores input on B');
    await rpc.x['engine-hermes'].profiles.create({ name: 'control_bot' });
    await rpc.computers.assign({ engine: 'hermes', targetId: 'control_bot', computerId: 'shared-chrome' });
    const aBinding = gateway.computers.binding('hermes', 'control_bot');
    assert.equal((await agentAction(aBinding)).status, 200, 'A available to another bot after swap');
    await eventually(() => viewer.evaluate('!(document.querySelector("[data-testid=stop-all-agents]")?.disabled || document.querySelector("[data-testid=stop-all-agents]")?.getAttribute("aria-disabled") === "true")'), 'stop control ready');
    await viewer.evaluate('document.querySelector("[data-testid=stop-all-agents]").click()');
    await eventually(async () => (await rpc.computers.state()).engaged, 'global kill switch');
    assert.equal((await agentAction(binding)).status, 403, 'kill switch blocks B');
    assert.equal((await agentAction(aBinding)).status, 403, 'kill switch blocks A');
    assert.ok(events.some((event) => event.type === 'run.completed'));
    await rpc.computers.kill({ engaged: false });
    assert.equal((await agentAction(aBinding)).status, 200, 'A resumes after kill cleared');
    assert.equal((await agentAction(binding)).status, 200, 'B resumes after kill cleared');
    await rpc.extensions.disable({ id: 'computer-local-sandbox' });
    await eventually(async () => !(await rpc.computers.list()).some(({ id }) => id === 'sandbox-b'), 'disabled B detached');
    assert.equal(gateway.computers.binding('hermes', 'chrome_bot'), undefined, 'bot has no computer after B disabled');
    assert.equal((await agentAction(binding)).status, 403, 'B capability revoked on disable');
    assert.equal((await agentAction(aBinding)).status, 200, 'A remains healthy after B disable');
    const noComputerEvents = await hermesRun(rpc, base, token, 'chrome_bot');
    assert.match(JSON.stringify(noComputerEvents), /No computer assigned to this bot/, 'bot gets a clear no-computer error');
    assert.ok(profileStops.length > stopsBeforeSwap, 'profile restart instrumentation observes lifecycle changes');
    assert.ok((await rpc.computers.capture({ id: 'shared-chrome' })).png.length > 50);
    await rpc.computers.release({ id: 'shared-chrome' });
    await eventually(async () => !(await rpc.computers.list()).some((computer) => computer.id === 'shared-chrome'), 'A release');
    await eventually(() => !isAlive(pid), 'Chrome PID exits', 15000);
    assert.equal((await fetch(base + '/x/sample-ts/hello', { headers: { authorization: `Bearer ${token}` } })).status, 200);
    await unregister();
    target.close();
    console.log('P3-3_GATEWAY_UI PASS A=navigate+click B=click sameBot=true liveAssignment=true lease=403 handback=200 killBoth=403 disableB=detached A=healthy');
  } finally {
    HermesRuntime.prototype.stopProfile = originalStop;
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
console.log('P3-3_EXIT PASS');
