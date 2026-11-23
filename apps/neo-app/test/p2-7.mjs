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
import { requireUpstreamCache } from '../../../tests/upstream-cache.mjs';
requireUpstreamCache('apps/neo-app/test/p2-7.mjs', ['hermes-agent']);

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '../..');
const token = '123456:local-channel-ui-token';
const responseText = 'Neo scripted worker reply';
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const phase = process.argv[2] ?? 'both';
assert.ok(['routines', 'kanban', 'both'].includes(phase), 'supported P2-7 test phase');

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

function modelServer() {
  let calls = 0;
  let completionRequested = false;
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
    const tools = request.tools?.map((tool) => tool.function?.name) ?? [];
    const isKanbanTurn = JSON.stringify(request.messages ?? []).includes('Complete scripted task');
    const invokeCompletion = isKanbanTurn && tools.includes('kanban_complete') && !completionRequested;
    if (invokeCompletion) completionRequested = true;
    const toolCall = { id: 'call_p27_kanban_complete', type: 'function', function: {
      name: 'kanban_complete', arguments: JSON.stringify({ summary: 'Scripted task completed successfully.' }),
    } };
    if (!request.stream) {
      json(res, { id: 'neo-channel', object: 'chat.completion', model: 'fake-model',
        choices: [{ index: 0, message: invokeCompletion
          ? { role: 'assistant', content: null, tool_calls: [toolCall] }
          : { role: 'assistant', content: responseText },
          finish_reason: invokeCompletion ? 'tool_calls' : 'stop' }] });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (invokeCompletion) {
      res.write('data: ' + JSON.stringify({ id: 'neo-channel', object: 'chat.completion.chunk', model: 'fake-model',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'neo-channel', object: 'chat.completion.chunk', model: 'fake-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }
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
  async type(selector, text) {
    assert.ok(await this.evaluate(`!!document.querySelector(${JSON.stringify(selector)}) && (document.querySelector(${JSON.stringify(selector)}).focus(), true)`));
    await this.send('Input.insertText', { text }, this.session);
  }
  close() { /* the provider owns the pipe; release() closes it */ }
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
  console.log('P2-7_STARTUP_JS PASS gzip=' + bytes);
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
  const temp = await mkdtemp(join(tmpdir(), 'nmh-p2-7-ui-'));
  const previous = Object.fromEntries(['NMH_HERMES_HOME', 'NMH_HERMES_MODEL_URL'].map((key) => [key, process.env[key]]));
  const model = modelServer();
  const chrome = new HeadlessChromeProvider();
  let gateway, preview, viewer;
  try {
    const modelPort = await listen(model.server);
    process.env.NMH_HERMES_HOME = join(temp, 'hermes');
    process.env.NMH_HERMES_MODEL_URL = `http://127.0.0.1:${modelPort}/v1`;
    gateway = await startGateway({ databaseFile: join(temp, 'neo.sqlite'), extensionsDir: join(repo, 'extensions'), mode: 'desktop' });
    const base = `http://127.0.0.1:${gateway.port}`;
    assert.ok(gateway.desktopToken, 'desktop gateway token');
    const rpc = createORPCClient(new RPCLink({ url: base, headers: { authorization: `Bearer ${gateway.desktopToken}` } }));
    assert.equal((await rpc.extensions.enable({ id: 'sample-ts' })).status, 'running');
    const started = await rpc.extensions.enable({ id: 'engine-hermes' });
    assert.equal(started.status, 'running', started.reason);
    await rpc.x['engine-hermes'].profiles.create({ name: 'work_bot' });

    const port = await freePort();
    preview = spawn(process.execPath, [join(app, 'node_modules/vite/bin/vite.js'), 'preview',
      '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      { cwd: app, windowsHide: true, stdio: 'ignore' });
    await eventually(async () => (await fetch(`http://127.0.0.1:${port}/routines`)).ok, 'Vite preview');
    await chrome.attach('viewer');
    viewer = await CDP.open(chrome.browser('viewer'));
    const url = (pathname) => `http://127.0.0.1:${port}${pathname}?gateway=${encodeURIComponent(base)}&token=${encodeURIComponent(gateway.desktopToken)}`;
    if (phase !== 'kanban') {
    await viewer.navigate(url('/routines'));
    await eventually(() => viewer.evaluate('!!document.querySelector("[data-testid=routines-page]")'), 'lazy Routines page');
    await eventually(() => viewer.evaluate('Array.from(document.querySelectorAll("#routine-profile option")).some(item => item.value === "work_bot")'), 'Hermes bot profile');
    await viewer.evaluate(`const input = document.querySelector('#routine-profile'); input.value = 'work_bot'; input.dispatchEvent(new Event('change', { bubbles: true }));`);
    await eventually(() => viewer.evaluate('document.querySelector("#routine-profile")?.value === "work_bot"'), 'selected bot profile');
    await viewer.type('[data-testid=routine-name]', 'E2E scheduled message');
    await viewer.evaluate('document.querySelector("[data-testid=routine-schedule]").value = ""; document.querySelector("[data-testid=routine-schedule]").dispatchEvent(new Event("input", { bubbles: true }));');
    // The ISO one-shot schedule is due shortly, so a real Hermes scheduler can claim it.
    const scheduled = new Date(Date.now() + 30000).toISOString();
    await viewer.evaluate(`const el = document.querySelector('[data-testid=routine-schedule]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(scheduled)}); el.dispatchEvent(new Event('input', { bubbles: true }));`);
    await viewer.type('[data-testid=routine-prompt]', 'Please reply with the scripted test response');
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=routine-prompt]")?.value.length > 10'), 'routine prompt composed');
    await viewer.evaluate('document.querySelector("[data-testid=routines-page] form").requestSubmit()');
    let jobs;
    await eventually(async () => { jobs = await rpc.x['engine-hermes'].cron.list({ profile: 'work_bot' }); return jobs.some((job) => job.name === 'E2E scheduled message'); }, 'routine persisted by UI');
    const job = jobs.find((item) => item.name === 'E2E scheduled message');
    assert.ok(job.id);
    console.log('P2-7_ROUTINE_CREATED');
    // Wait for the real Hermes scheduler to fire the routine at its due time.
    await eventually(async () => (await rpc.x['engine-hermes'].cron.history({ id: job.id, profile: 'work_bot' })).runs.length > 0,
      'Hermes scheduled cron run history', 150000);
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=routine-history]")?.innerText.includes("Run")'), 'UI routine history populated');
    // Pause a recurring routine with a future due time. One-shots transition to completed after firing.
    const recurring = await rpc.x['engine-hermes'].cron.create({
      profile: 'work_bot', name: 'E2E paused recurring', prompt: 'This must never run', schedule: 'every 1m',
    });
    assert.ok(recurring.id);
    const recurringJob = (await rpc.x['engine-hermes'].cron.list({ profile: 'work_bot' })).find((item) => item.id === recurring.id);
    assert.ok(recurringJob?.next_run_at, 'recurring routine has a next execution');
    await eventually(() => viewer.evaluate('Array.from(document.querySelectorAll("[data-testid=routine-card]")).some(card => card.textContent.includes("E2E paused recurring"))'), 'recurring routine visible');
    await viewer.evaluate(`(() => { const card = Array.from(document.querySelectorAll('[data-testid=routine-card]')).find(item => item.textContent.includes('E2E paused recurring')); const pauseButton = Array.from(card.querySelectorAll('button')).find(item => item.textContent.trim() === 'Pause'); pauseButton.click(); })()`);
    await eventually(async () => (await rpc.x['engine-hermes'].cron.list({ profile: 'work_bot' })).some((item) => item.id === recurring.id && item.state === 'paused' && item.enabled === false), 'recurring routine paused');
    await eventually(() => viewer.evaluate('Array.from(document.querySelectorAll("[data-testid=routine-card]")).some(card => card.textContent.includes("E2E paused recurring") && card.textContent.includes("Paused"))'), 'UI shows paused');
    const nextDue = Date.parse(String(recurringJob.next_run_at));
    assert.ok(Number.isFinite(nextDue), 'recurring next run time is valid');
    await pause(Math.max(0, nextDue + 65000 - Date.now()));
    assert.equal((await rpc.x['engine-hermes'].cron.history({ id: recurring.id, profile: 'work_bot' })).runs.length, 0, 'paused recurring routine skipped a scheduler interval');
    await viewer.evaluate(`(() => { const card = Array.from(document.querySelectorAll('[data-testid=routine-card]')).find(item => item.textContent.includes('E2E paused recurring')); Array.from(card.querySelectorAll('button')).find(item => item.textContent.trim() === 'Edit').click(); })()`);
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=routine-name]")?.value === "E2E paused recurring"'), 'routine edit form loaded');
    await viewer.evaluate(`(() => { const el = document.querySelector('[data-testid=routine-name]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, 'E2E edited routine'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await viewer.evaluate('document.querySelector("[data-testid=routines-page] form").requestSubmit()');
    await eventually(async () => (await rpc.x['engine-hermes'].cron.list({ profile: 'work_bot' })).some((item) => item.id === recurring.id && item.name === 'E2E edited routine'), 'routine edited by UI');
    await viewer.evaluate(`(() => { const card = Array.from(document.querySelectorAll('[data-testid=routine-card]')).find(item => item.textContent.includes('E2E edited routine')); Array.from(card.querySelectorAll('button')).find(item => item.textContent.trim() === 'Delete').click(); })()`);
    await eventually(async () => !(await rpc.x['engine-hermes'].cron.list({ profile: 'work_bot' })).some((item) => item.id === recurring.id), 'routine deleted by UI');
    console.log('P2-7_CRON_HISTORY PASS');
    }

    if (phase !== 'routines') {
    await viewer.navigate(url('/tasks'));
    await eventually(() => viewer.evaluate('!!document.querySelector("[data-testid=tasks-page]")'), 'lazy Tasks page');
    await viewer.evaluate(`(() => { const el = document.querySelector('[data-testid=tasks-slug]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, 'p2-7-space'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=tasks-slug]")?.value === "p2-7-space"'), 'workspace slug entered');
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=tasks-create-board]")?.getAttribute("aria-disabled") !== "true"'), 'workspace submit enabled');
    await viewer.evaluate('document.querySelector("[data-testid=tasks-create-board]").click()');
    try {
      await eventually(async () => (await rpc.x['engine-hermes'].kanban.boards()).boards.some((board) => board.slug === 'p2-7-space'), 'workspace board created', 20000);
    } catch (error) {
      const uiState = await viewer.evaluate(`({ error: document.querySelector('[data-testid=tasks-page] [role=alert]')?.textContent, slug: document.querySelector('[data-testid=tasks-slug]')?.value, status: document.querySelector('[data-testid=tasks-status]')?.textContent })`);
      throw new Error(`${String(error)}; Tasks UI: ${JSON.stringify(uiState)}`);
    }
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=tasks-workspace]")?.value === "p2-7-space"'), 'workspace selected');
    await viewer.type('[data-testid=tasks-title]', 'Complete scripted task');
    await viewer.type('[data-testid=tasks-body]', 'Produce a concise reply using the scripted model');
    await eventually(() => viewer.evaluate('Array.from(document.querySelector("#tasks-assignee")?.options ?? []).some(option => option.value === "work_bot")'), 'Hermes bot available in UI');
    await viewer.evaluate(`const select = document.querySelector('#tasks-assignee'); select.value = 'work_bot'; select.dispatchEvent(new Event('change', { bubbles: true }));`);
    await eventually(() => viewer.evaluate('document.querySelector("#tasks-assignee")?.value === "work_bot"'), 'bot selection applied');
    await viewer.evaluate('document.querySelector("[data-testid=tasks-create]").click()');
    let board;
    await eventually(async () => {
      board = await rpc.x['engine-hermes'].kanban.board({ workspace: 'p2-7-space' });
      return board.columns.some((column) => column.tasks.some((task) => task.title === 'Complete scripted task' && task.assignee === 'work_bot'));
    }, 'task assigned to Hermes bot');
    const item = board.columns.flatMap((column) => column.tasks).find((task) => task.title === 'Complete scripted task');
    assert.ok(item?.id);
    await viewer.evaluate('document.querySelector("[data-testid=tasks-dispatch]").click()');
    await eventually(async () => {
      const current = await rpc.x['engine-hermes'].kanban.board({ workspace: 'p2-7-space' });
      return current.columns.some((column) => column.name === 'done' && column.tasks.some((task) => task.id === item.id));
    }, 'Hermes worker completes task', 120000);
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=tasks-column-done]")?.innerText.includes("Complete scripted task")'), 'UI board displays completion');
    assert.ok(model.calls > 0, 'scripted model called');
    console.log('P2-7_KANBAN PASS bot=work_bot status=done');
    }

    await rpc.extensions.disable({ id: 'engine-hermes' });
    if (phase !== 'routines') await eventually(() => viewer.evaluate('document.querySelector("[data-testid=tasks-status]")?.textContent.includes("disabled")'), 'Tasks disabled');
    if (phase !== 'kanban') {
      await viewer.navigate(url('/routines'));
      await eventually(() => viewer.evaluate('document.querySelector("[data-testid=routines-status]")?.textContent.includes("disabled")'), 'Routines disabled');
    }
    assert.equal((await rpc.extensions.list()).find((item) => item.id === 'sample-ts')?.status, 'running');
    assert.equal((await fetch(`${base}/x/sample-ts/hello`, { headers: { authorization: `Bearer ${gateway.desktopToken}` } })).status, 200);
    console.log('P2-7_UI PASS phase=' + phase + ' disabled=visible sample=healthy');
  } finally {
    viewer?.close();
    await chrome.release('viewer');
    stopChild(preview);
    await gateway?.close();
    await closeServer(model.server);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(temp, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 });
  }
}

await buildCurrentTree();
await main();
console.log('P2-7_EXIT PASS');
