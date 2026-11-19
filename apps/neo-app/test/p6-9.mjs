import assert from 'node:assert/strict';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '../..');
const gatewayDir = join(repo, 'apps', 'gateway');
const uiDir = join(repo, 'packages', 'ui');
const chromeBinary = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function nodeTool(cwd, tool, args) {
  console.log(`RUN ${tool} ${args.join(' ')}`);
  execFileSync(process.execPath, [join(cwd, 'node_modules', tool), ...args], { cwd, stdio: 'inherit' });
}

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve test port');
  await new Promise((done) => server.close(done));
  return address.port;
}

async function awaitHttp(url, label) {
  for (let retry = 0; retry < 100; retry++) {
    try { if ((await fetch(url)).ok) return; } catch { /* process not ready */ }
    await sleep(100);
  }
  throw new Error(`${label} did not respond at ${url}`);
}

function upstreamCache() {
  if (process.env.NMH_UPSTREAM_CACHE) return process.env.NMH_UPSTREAM_CACHE;
  for (let parent = repo; ; parent = dirname(parent)) {
    const candidate = join(parent, 'nmh-upstream-cache');
    if (existsSync(candidate)) return candidate;
    if (dirname(parent) === parent) throw new Error('Set NMH_UPSTREAM_CACHE to the pinned source cache');
  }
}

let AUTH = '';
const authHeaders = () => ({ authorization: `Bearer ${AUTH}` });

async function startGateway(dbFile, hermesHome, modelUrl, dshUrl) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: gatewayDir,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    env: {
      ...process.env, NODE_ENV: 'test',
      NMH_SUPERAGENT_TEST_ADAPTER: new URL('../../../extensions/engine-superagent/test/scripted-models.ts', import.meta.url).href,
      NMH_UPSTREAM_CACHE: upstreamCache(),
      NMH_DB_PATH: dbFile, NMH_HERMES_HOME: hermesHome, NMH_HERMES_MODEL_URL: modelUrl,
      NMH_SUPERAGENT_MODEL_URL: dshUrl, NMH_EXTENSIONS_DIR: join(repo, 'extensions'), NMH_PORT: '0', NEO_MODE: 'desktop', NEO_PRINT_DESKTOP_TOKEN: '1',
    },
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
  const port = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gateway startup timed out: ${errors}`)), 20000);
    const lines = createInterface({ input: child.stdout });
    const success = (portNumber) => { clearTimeout(timer); lines.close(); done(portNumber); };
    const fail = (error) => { clearTimeout(timer); lines.close(); reject(error); };
    lines.on('line', (line) => {
      if (line.startsWith('NEO_DESKTOP_TOKEN ')) AUTH = line.slice('NEO_DESKTOP_TOKEN '.length).trim();
      if (line.startsWith('GATEWAY_READY ')) success(JSON.parse(line.slice('GATEWAY_READY '.length)).port);
    });
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`Gateway exited ${code}: ${errors}`)));
  });
  return { port, child, errors: () => errors, async close() {
    if (child.exitCode !== null) return;
    const exit = new Promise((done) => child.once('exit', done));
    child.send('shutdown');
    await Promise.race([exit, sleep(10000).then(() => { throw new Error(`Gateway shutdown timeout: ${errors}`); })]);
    assert.equal(child.exitCode, 0, `Gateway shutdown error: ${errors}`);
  } };
}

async function fakeDshModel() {
  const seen = [];
  const server = createHttpServer(async (req, res) => {
    if (req.method !== 'POST' || !['/evaluate', '/generate'].includes(req.url)) {
      res.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (req.url === '/evaluate') {
        const { prompt } = JSON.parse(Buffer.concat(chunks).toString());
        const request = JSON.parse(prompt.find((part) => part.type === 'text').text);
        assert.ok(request.evalId && request.botId && request.text);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ decision: 'accept' }));
        return;
      }
      const request = JSON.parse(Buffer.concat(chunks).toString());
      assert.ok(request.tools.includes(request.tool));
      assert.match(request.tool, /^mcp__neo__agents_send_to_bot_[a-f0-9]+$/);
      assert.ok(request.args.botId && request.args.text);
      seen.push(request);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ action: request.stage === 1 ? 'delegate' : 'finish' }));
    } catch (error) { res.writeHead(500).end(String(error)); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, port: address.port, seen };
}


async function eventually(check, label, timeout = 90000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) { lastError = error; }
    await sleep(200);
  }
  throw new Error(`${label} timed out${lastError ? ': ' + lastError.message : ''}`);
}

async function startChrome(profile) {
  const child = spawn(chromeBinary, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let port;
  for (let retry = 0; retry < 100; retry++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { if (child.exitCode !== null) throw new Error(`Chrome exited ${child.exitCode}`); await sleep(100); }
  }
  if (!port) throw new Error('Chrome debugging port unavailable');
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  let next = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((done, reject) => {
    const id = ++next;
    pending.set(id, (message) => message.error ? reject(new Error(`${method}: ${message.error.message}`)) : done(message.result));
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return { child, socket, send, close() {
    socket.close();
    if (process.platform === 'win32') spawnSync(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill();
  } };
}

async function pageSession(chrome, url) {
  const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await chrome.send('Target.attachToTarget', { targetId, flatten: true });
  await chrome.send('Runtime.enable', {}, sessionId);
  await chrome.send('Page.enable', {}, sessionId);
  await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await chrome.send('Page.navigate', { url }, sessionId);
  const evaluate = async (expression) => {
    const result = await chrome.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(`Browser exception: ${result.exceptionDetails.text} ${result.result?.description ?? ''}`);
    return result.result.value;
  };
  const eventually = async (expression, description) => {
    for (let retry = 0; retry < 450; retry++) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw new Error(`Browser never observed ${description}. DOM=${(await evaluate('document.body?.innerText'))?.slice(0, 700)}`);
  };
  return {
    evaluate,
    eventually,
    async typeText(text) {
      await chrome.send('Input.insertText', { text }, sessionId);
    },
    async pressEnter() {
      await chrome.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
      }, sessionId);
      await chrome.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
      }, sessionId);
    },
    async screenshot(file) {
      const { data } = await chrome.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
      await writeFile(file, Buffer.from(data, 'base64'));
    },
    async close() { await chrome.send('Target.closeTarget', { targetId }); },
  };
}


/** Scripted Hermes model. The screenshot is executed by Hermes' real MCP client. */
async function fakeHermesModel() {
  const seen = [];
  const server = createHttpServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
      return;
    }
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) { res.writeHead(404).end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    seen.push(input);
    const prompt = JSON.stringify(input.messages ?? []);
    const isResearch = prompt.includes('Research Y');
    const called = input.messages?.some(m => m.role === 'tool');
    const tool = isResearch && !called ? { id: 'p69-shot', type: 'function',
      function: { name: 'tool_call', arguments: JSON.stringify({ calls: [{ name: 'mcp__neo_computers__screenshot', arguments: {} }] }) } } : undefined;
    const text = prompt.includes('Remember Z:') ? 'Remembered p69-zebra-rendezvous: cobalt orchard.'
      : 'Monday research report: the bot inspected its computer through MCP.';
    const answer = tool ? { role: 'assistant', content: null, tool_calls: [tool] } : { role: 'assistant', content: text };
    const finish = tool ? 'tool_calls' : 'stop';
    if (!input.stream) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'p69', object: 'chat.completion', model: 'fake-model',
        choices: [{ index: 0, message: answer, finish_reason: finish }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'p69', object: 'chat.completion.chunk', created: 1,
      model: 'fake-model', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    emit({ role: 'assistant' });
    emit(tool ? { tool_calls: [{ index: 0, ...tool }] } : { content: text });
    emit({}, finish); res.end('data: [DONE]\n\n');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { server, port: server.address().port, seen };
}

/** Inspect the actual production MCP server over stdio; no tool bodies are replaced. */
async function listWorkerTools(base) {
  const child = spawn(process.execPath, [join(repo, 'extensions/engine-superagent/src/mcp-server.mjs'), base],
    { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
  const lines = createInterface({ input: child.stdout });
  let errors = '';
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-1000); });
  try {
    return await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker MCP inventory timeout: ${errors}`)), 15000);
      const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
      lines.on('line', line => {
        let message; try { message = JSON.parse(line); } catch { return; }
        if (message.id === 1) {
          if (message.error) { clearTimeout(timer); reject(new Error(JSON.stringify(message.error))); return; }
          send({ method: 'notifications/initialized' }); send({ id: 2, method: 'tools/list', params: {} });
        }
        if (message.id === 2) {
          clearTimeout(timer);
          if (message.error) reject(new Error(JSON.stringify(message.error)));
          else done(message.result.tools.map(t => t.name));
        }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'p6-9-probe', version: '1' } } });
    });
  } finally { lines.close(); child.stdin.end(); child.kill(); }
}

async function trial(previewPort) {
  const temporary = await mkdtemp(join(tmpdir(), 'nmh-p6-9-'));
  const hermes = await fakeHermesModel();
  const dsh = await fakeDshModel();
  let gateway, chrome, page;
  try {
    gateway = await startGateway(join(temporary, 'state.sqlite'), join(temporary, 'hermes-home'),
      `http://127.0.0.1:${hermes.port}/v1`, `http://127.0.0.1:${dsh.port}`);
    const base = `http://127.0.0.1:${gateway.port}`;
    const blockers = [];
    const rpc = createORPCClient(new RPCLink({ url: base, headers: authHeaders }));
    assert.equal((await fetch(base + '/rpc/inbox/list', { method: 'POST' })).status, 401);
    for (const id of ['sample-ts', 'computer-fake', 'computers-mcp', 'memory-local', 'engine-hermes', 'engine-superagent']) {
      const result = await rpc.extensions.enable({ id });
      assert.equal(result.status, 'running', `${id}: ${result.reason ?? gateway.errors()}`);
    }
    const bot = await rpc.agents.bots.create({ name: 'P6-9 Monday researcher' });
    const computer = await rpc.computers.attach({ providerId: 'computer-fake', target: 'p69-screen' });
    await rpc.computers.assign({ engine: 'hermes', targetId: 'neo_' + bot.id.replace(/-/g, '').toLowerCase(), computerId: computer.id });
    const job = await rpc.inbox.cron.create({ botId: bot.id, text: 'Research Y on my computer every Monday',
      schedule: '0 9 * * 1', mode: 'act' });
    assert.equal(job.schedule, '0 9 * * 1');
    await rpc.inbox.cron.fire({ id: job.id });
    const report = await eventually(async () => (await rpc.inbox.list()).find(i => i.source === 'neo/cron' && i.text === job.text
      && ['ready', 'failed', 'blocked'].includes(i.status)), 'Monday research report');
    assert.equal(report.status, 'ready', JSON.stringify(report.report));
    assert.match(report.report.summary, /bot inspected its computer/);
    const calls = await (await fetch(base + '/x/computer-fake/calls', { headers: authHeaders() })).json();
    assert.ok(calls.some(c => c.action === 'capture' && c.computerId === 'p69-screen'), JSON.stringify({ calls, tools: hermes.seen.map(c => c.tools?.map(t => t.function?.name)), results: hermes.seen.flatMap(c => c.messages?.filter(m => m.role === 'tool') ?? []).map(m => JSON.stringify(m).slice(0,1200)), errors: gateway.errors().slice(-2000) }));
    assert.ok(hermes.seen.some(call => JSON.stringify(call.messages).includes('mcp__neo_computers__screenshot')), 'Real Hermes executed projected MCP screenshot');
    assert.ok(hermes.seen.some(call => call.messages?.some(m => m.role === 'tool')), 'Real Hermes resumed after MCP result');
    chrome = await startChrome(join(temporary, 'chrome'));
    page = await pageSession(chrome, `http://127.0.0.1:${previewPort}/inbox?gateway=${encodeURIComponent(base)}&token=${encodeURIComponent(AUTH)}`);
    await page.eventually('document.body.innerText.includes("Monday research report")', 'MCP research report in App Inbox');
    console.log('P6-9_SCENARIO_2 PASS authenticated=true real_gateway_app=true scripted_models=true fake_computer=true cron_monday=true bot_MCP_capture=true inbox_report=true');
    // Submit the second task through the actual App composer, not a synthetic Inbox write.
    await page.evaluate(`(() => {
      const field = document.querySelector('.inbox-composer textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'Remember Z: p69-zebra-rendezvous is cobalt orchard.');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await page.evaluate(`document.querySelector('.inbox-modes input[value=act]').click()`);
    await page.eventually(`(() => { const e=document.querySelector('.inbox-composer button[type=submit]'); return e && !e.disabled && e.getAttribute('aria-disabled')!=='true'; })()`, 'Ask Neo enabled');
    await page.evaluate(`document.querySelector('.inbox-composer button[type=submit]').click()`);
    await page.eventually('document.body.innerText.includes("Remembered p69-zebra-rendezvous")', 'remember turn report');
    await eventually(async () => (await rpc.x['memory-local'].list({ workspace: 'default' }))
      .some(e => e.source === 'hermes.turn' && e.text.includes('cobalt orchard')), 'engine memory write');
    for (const id of ['models', 'engine-dsh']) {
      const result = await rpc.extensions.enable({ id }); assert.equal(result.status, 'running', JSON.stringify(result));
    }
    await rpc.x.models.providers.put({ id: 'p69-scripted', kind: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${hermes.port}/v1`, apiKey: 'fake-p69-only' });
    await rpc.x.models.roles.set({ role: 'coding', providerId: 'p69-scripted', model: 'p69-memory-reader' });
    const reader = await rpc.x['engine-dsh'].create({ workspaceId: 'default', cwd: temporary, plugins: { skills: false, report: false } });
    try {
      await rpc.x['engine-dsh'].prompt({ sessionId: reader.sessionId, text: 'p69-zebra-rendezvous' });
      await rpc.x['engine-dsh'].wait({ sessionId: reader.sessionId });
      const readCalls = hermes.seen.filter(c => c.model === 'p69-memory-reader');
      assert.ok(readCalls.length, 'Unmodified DSH reached the scripted endpoint');
      if (!readCalls.some(c => JSON.stringify(c.messages).includes('cobalt orchard'))) {
        blockers.push('Scenario 3: Hermes wrote Z, but a later DSH turn in the same workspace received no Z context (engine profile scope).');
        console.log('P6-9_SCENARIO_3 FAIL engine_write=true other_engine_turn=true recalled=false');
      }
    } finally { await rpc.x['engine-dsh'].shutdown({ sessionId: reader.sessionId }); }
    await page.close(); page = undefined;
    await gateway.close(); gateway = undefined;
    gateway = await startGateway(join(temporary, 'state.sqlite'), join(temporary, 'hermes-home'),
      `http://127.0.0.1:${hermes.port}/v1`, `http://127.0.0.1:${dsh.port}`);
    const restored = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${gateway.port}`, headers: authHeaders }));
    assert.ok((await restored.inbox.list()).some(i => i.id === report.id && i.report?.summary === report.report.summary));
    assert.ok((await restored.inbox.cron.list()).some(j => j.id === job.id && j.schedule === '0 9 * * 1'));
    assert.ok((await restored.agents.bots.list()).some(b => b.id === bot.id));
    console.log('P6-9_RESTART PASS report=true routine=true bot=true');
    // This suite must fail until all three exit scenarios run. Never report a partial exit as PASS.
    const workerTools = await listWorkerTools(base);
    if (!workerTools.some(name => /coding|t3/.test(name))) blockers.push(`Scenario 1: superagent MCP inventory has no coding delegate (${workerTools.join(', ')}).`);
    blockers.push('Scenario 1 remains unimplemented: App-origin WhatsApp notification destination and fake PR lifecycle.');
    assert.deepEqual(blockers, [], 'P6-9 exit blockers (see docs/testing/p6-9.md)');
  } finally {
    if (page) await page.close().catch(() => {});
    chrome?.close();
    if (gateway) await gateway.close();
    await Promise.all([new Promise(done => hermes.server.close(done)), new Promise(done => dsh.server.close(done))]);
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

try {
  nodeTool(app, 'vite/bin/vite.js', ['build']);
  const port = await freePort();
  const preview = spawn(process.execPath, [join(app, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: app, stdio: 'ignore', windowsHide: true });
  try { await awaitHttp(`http://127.0.0.1:${port}/inbox`, 'App preview'); await trial(port); }
  finally {
    if (process.platform === 'win32') spawnSync(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(preview.pid), '/T', '/F'], { windowsHide: true });
    else preview.kill();
  }
} catch (error) { console.error('P6-9 FAIL', error.stack ?? error); process.exitCode = 1; }
