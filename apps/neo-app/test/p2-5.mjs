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
import { RPCLink } from '@orpc/client/fetch';
import { startGateway } from '../../gateway/src/server.ts';
import { HeadlessChromeProvider } from '../../../extensions/computer-headless-chrome/src/index.ts';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '../..');
const token = '123456:local-channel-ui-token';
const responseText = 'Neo test Telegram response';
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function listen(server) {
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  return server.address().port;
}

async function freePort() {
  const server = netServer();
  const port = await listen(server);
  await new Promise((done) => server.close(done));
  return port;
}

async function eventually(check, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let problem;
  while (Date.now() < deadline) {
    try { if (await check()) return; }
    catch (error) { problem = error; }
    await pause(150);
  }
  throw new Error(label + ' timed out (' + String(problem ?? 'condition false') + ')');
}

async function requestBody(req) {
  const parts = [];
  for await (const item of req) parts.push(item);
  const raw = Buffer.concat(parts).toString();
  if (!raw) return {};
  return req.headers['content-type']?.includes('application/json')
    ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function telegramServer() {
  const updates = [];
  const calls = [];
  const bot = { id: 7000000001, is_bot: true, first_name: 'Hermes', username: 'fake_neo_bot',
    can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false };
  const chat = { id: 111, type: 'private', first_name: 'Tester', username: 'tester111' };
  let nextId = 1000;
  const server = httpServer(async (req, res) => {
    const match = /^\/bot([^/]+)\/([^/]+)$/.exec(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (!match || match[1] !== token) {
      json(res, { ok: false, error_code: 401, description: 'Unauthorized' }, 401);
      return;
    }
    const params = await requestBody(req);
    const method = match[2];
    calls.push({ method, params });
    let result;
    if (method === 'getUpdates') {
      const offset = Number(params.offset ?? 0);
      result = updates.filter((message) => message.update_id >= offset);
      if (!result.length) await pause(120);
    } else if (method === 'getMe') result = bot;
    else if (method === 'getMyCommands') result = [];
    else if (method === 'getChat') result = { ...chat, accent_color_id: 0, max_reaction_count: 11 };
    else if (['sendMessage', 'editMessageText', 'sendRichMessage'].includes(method)) {
      result = { message_id: ++nextId, date: Math.floor(Date.now() / 1000), chat, from: bot,
        text: String(params.text ?? '') };
    } else if (['sendMessageDraft', 'sendRichMessageDraft', 'setMyCommands', 'deleteMyCommands',
      'setMyDescription', 'setMyShortDescription', 'deleteWebhook', 'sendChatAction',
      'setMessageReaction', 'answerCallbackQuery', 'deleteMessage'].includes(method)) result = true;
    else { json(res, { ok: false, error_code: 404, description: 'Not Found' }, 404); return; }
    json(res, { ok: true, result });
  });
  return { server, calls, dm(text) {
    updates.push({ update_id: ++nextId, message: { message_id: ++nextId,
      date: Math.floor(Date.now() / 1000), chat,
      from: { id: 111, is_bot: false, first_name: 'Tester', username: 'tester111', language_code: 'en' },
      text } });
  } };
}

function modelServer() {
  let calls = 0;
  const server = httpServer(async (req, res) => {
    if (req.url === '/v1/models') {
      json(res, { object: 'list', data: [{ id: 'fake-model', object: 'model' }] });
      return;
    }
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      json(res, {}, 404);
      return;
    }
    const request = await requestBody(req);
    calls++;
    if (!request.stream) {
      json(res, { id: 'neo-channel', object: 'chat.completion', model: 'fake-model',
        choices: [{ index: 0, message: { role: 'assistant', content: responseText },
          finish_reason: 'stop' }] });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const delta of [{ role: 'assistant', content: '' }, { content: responseText }, {}]) {
      res.write('data: ' + JSON.stringify({ id: 'neo-channel', object: 'chat.completion.chunk',
        created: 1, model: 'fake-model',
        choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : 'stop' }] }) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  return { server, get calls() { return calls; } };
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
  async type(selector, text) {
    assert.ok(await this.evaluate(`!!document.querySelector(${JSON.stringify(selector)}) && (document.querySelector(${JSON.stringify(selector)}).focus(), true)`));
    await this.send('Input.insertText', { text }, this.session);
  }
  close() { this.socket.close(); }
}

async function buildCurrentTree() {
  const result = spawnSync(process.execPath, [join(app, 'node_modules/vite/bin/vite.js'), 'build'],
    { cwd: app, windowsHide: true, stdio: 'inherit' });
  assert.equal(result.status, 0, 'Vite build must succeed before test');
  const html = await readFile(join(app, 'dist/index.html'), 'utf8');
  const scripts = new Set();
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const attributes = Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*["']([^"']+)["']/g)]
      .map(([, key, value]) => [key.toLowerCase(), value]));
    if (tag.startsWith('<script') && attributes.type === 'module' && attributes.src) scripts.add(attributes.src);
    if (tag.startsWith('<link') && attributes.rel === 'modulepreload' && attributes.href) scripts.add(attributes.href);
  }
  assert.ok(scripts.size, 'startup entry exists');
  const bytes = (await Promise.all([...scripts].map(async (path) =>
    gzipSync(await readFile(join(app, 'dist', path.replace(/^\//, '')))).length)))
    .reduce((sum, size) => sum + size, 0);
  assert.ok(bytes <= 300 * 1024, 'startup JS exceeds 300 KB gzip');
  console.log('P2-5_STARTUP_JS PASS gzip=' + bytes);
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

function stopChild(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync(
    join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe'),
    ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGKILL');
}

async function main() {
  const temp = await mkdtemp(join(tmpdir(), 'nmh-p2-5-ui-'));
  const previous = Object.fromEntries(['NMH_HERMES_HOME', 'NMH_HERMES_MODEL_URL',
    'NMH_CHANNELS_TELEGRAM_API_BASE'].map((name) => [name, process.env[name]]));
  const telegram = telegramServer();
  const model = modelServer();
  const chrome = new HeadlessChromeProvider();
  let gateway, preview, viewer;
  try {
    const tgPort = await listen(telegram.server);
    const modelPort = await listen(model.server);
    process.env.NMH_HERMES_HOME = join(temp, 'hermes');
    process.env.NMH_HERMES_MODEL_URL = 'http://127.0.0.1:' + modelPort + '/v1';
    process.env.NMH_CHANNELS_TELEGRAM_API_BASE = 'http://127.0.0.1:' + tgPort + '/';

    gateway = await startGateway({ databaseFile: join(temp, 'neo.sqlite'), extensionsDir: join(repo, 'extensions') });
    const base = 'http://127.0.0.1:' + gateway.port;
    const rpc = createORPCClient(new RPCLink({ url: base }));
    assert.equal((await rpc.extensions.enable({ id: 'sample-ts' })).status, 'running');
    assert.equal((await rpc.extensions.enable({ id: 'engine-hermes' })).status, 'running');
    await rpc.x['engine-hermes'].profiles.create({ name: 'channel_ui' });
    const enabled = await rpc.extensions.enable({ id: 'channels' });
    assert.equal(enabled.status, 'running', enabled.reason);

    const port = await freePort();
    preview = spawn(process.execPath, [join(app, 'node_modules/vite/bin/vite.js'), 'preview',
      '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: app, windowsHide: true, stdio: 'ignore' });
    await eventually(async () => (await fetch('http://127.0.0.1:' + port + '/settings')).ok, 'Vite preview');
    await chrome.attach('viewer');
    viewer = await CDP.open(chrome.browser('viewer'));
    await viewer.navigate('http://127.0.0.1:' + port + '/settings?gateway=' + encodeURIComponent(base));
    await eventually(() => viewer.evaluate('!!document.querySelector("[data-testid=settings-channels-open]")'), 'Settings Channels entry');
    await viewer.evaluate('document.querySelector("[data-testid=settings-channels-open]").click()');
    await eventually(() => viewer.evaluate('location.pathname === "/settings/channels"'), 'Settings Channels navigation');
    await eventually(() => viewer.evaluate('!!document.querySelector("[data-testid=channels-page]")'), 'lazy Channels route');
    await eventually(() => viewer.evaluate('Array.from(document.querySelectorAll("#channels-profile option")).some(item => item.value === "channel_ui")'), 'profile list from Hermes');
    await viewer.evaluate(`const select = document.querySelector('#channels-profile'); select.value = 'channel_ui'; select.dispatchEvent(new Event('change', { bubbles: true }));`);
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=channels-status]")?.textContent?.includes("disconnected") && !!document.querySelector("#channels-platform option[value=telegram]")'), 'platform picker populated by Hermes');
    await viewer.type('[data-testid=channels-token]', token);
    await viewer.evaluate('document.querySelector("[data-testid=channels-connect]").click()');
    await eventually(async () => (await rpc.x.channels.status({ profile: 'channel_ui' })).platforms.find((item) => item.id === 'telegram')?.configured, 'UI token stored in vault');
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=channels-token]")?.value === "" && document.body.innerText.includes("Telegram connected")'), 'write-only token cleared after connect');
    await eventually(() => telegram.calls.some((call) => call.method === 'getUpdates'), 'Hermes Telegram polling active');
    telegram.dm('Send fake Telegram reply');
    await eventually(() => telegram.calls.some((call) => call.method === 'sendMessage' &&
      String(call.params.text ?? '').includes(responseText)), 'fake API inbound to model to reply', 60000);
    assert.ok(model.calls > 0, 'scripted model invoked');

    await viewer.evaluate('document.querySelector("[data-testid=channels-disconnect]").click()');
    await eventually(async () => !(await rpc.x.channels.status({ profile: 'channel_ui' })).platforms.find((item) => item.id === 'telegram')?.configured,
      'UI disconnect removed vault token');
    await eventually(() => viewer.evaluate('document.body.innerText.includes("Telegram disconnected")'), 'disconnect feedback');
    await rpc.extensions.disable({ id: 'channels' });
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=channels-status]")?.textContent?.includes("disabled")'), 'disabled state shown on page', 15000);
    assert.equal((await fetch(base + '/x/sample-ts/hello')).status, 200);
    assert.equal((await rpc.extensions.list()).find((item) => item.id === 'sample-ts')?.status, 'running');
    console.log('P2-5_GATEWAY_UI PASS lazy=channels bot=selected telegram=live-roundtrip token=write-only disconnect=cleared disabled=visible sample=healthy');
  } finally {
    viewer?.close();
    await chrome.release('viewer');
    stopChild(preview);
    await gateway?.close();
    await closeServer(telegram.server);
    await closeServer(model.server);
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(temp, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 });
  }
}

await buildCurrentTree();
await main();
console.log('P2-5_EXIT PASS');
