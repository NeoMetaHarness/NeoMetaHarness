import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { T3ControlPlane } from '../../../extensions/engine-t3/src/client.ts';
import { createRequire } from 'node:module';
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
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const { build: bundle } = createRequire(join(repo, 'extensions/engine-t3/package.json'))('esbuild');

function upstreamCache() {
  if (process.env.NMH_UPSTREAM_CACHE) return process.env.NMH_UPSTREAM_CACHE;
  for (let location = repo; ; location = dirname(location)) {
    const candidate = join(location, 'nmh-upstream-cache');
    if (existsSync(candidate)) return candidate;
    if (dirname(location) === location) throw new Error('nmh-upstream-cache not found; set NMH_UPSTREAM_CACHE');
  }
}
const ref = JSON.parse(readFileSync(join(repo, 'upstream.lock.json'), 'utf8')).pins.t3code.ref;
const upstream = join(upstreamCache(), 't3code@' + ref);
const t3Exe = join(process.env.LOCALAPPDATA ?? '', 'Programs/t3code/T3 Code (Beta).exe');
const t3Archive = join(process.env.LOCALAPPDATA ?? '', 'Programs/t3code/resources/server.asar');
const t3Entry = join(t3Archive, 'apps/server/dist/bin.mjs');
// Electron resolves paths inside server.asar even though they are not physical files.
assert.ok(existsSync(t3Exe) && existsSync(t3Archive),
  'isolated T3 test needs the installed desktop CLI');
// The isolated fake provider inherits only the OS environment needed for child processes.
const allowedEnv = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
  'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'PROCESSOR_ARCHITECTURE',
]);
const cleanEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => allowedEnv.has(name.toUpperCase())));

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function eventually(check, label, ms = 50000) {
  let problem;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (await check()) return; }
    catch (error) { problem = error; }
    await pause(120);
  }
  throw new Error(label + ' timed out: ' + String(problem ?? ''));
}
async function capture(child) {
  return new Promise((done, reject) => {
    let output = '';
    let errors = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { errors += chunk.toString().slice(0, 5000); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? done(output.trim()) : reject(new Error('T3 command failed ' + code + ': ' + errors)));
  });
}
function spawnT3(args, state) {
  return spawn(t3Exe, [t3Entry, ...args], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...cleanEnv, ELECTRON_RUN_AS_NODE: '1', T3CODE_DESKTOP_CLI_LAUNCHER: '1', T3CODE_HOME: state },
  });
}
async function waitT3(url, child) {
  await eventually(async () => {
    assert.equal(child.exitCode, null, 'isolated T3 process exited');
    try {
      const response = await fetch(url + '/api/auth/websocket-ticket', {
        method: 'POST', signal: AbortSignal.timeout(1200),
      });
      return response.status === 401 || response.status === 403;
    } catch { return false; }
  }, 'isolated T3 readiness', 25000);
}
async function pinnedSetup(temp, url, session, providerId, projectId) {
  const entry = join(repo, 'extensions/coding-workflow/test/wire.entry.ts');
  const output = join(temp, 'pinned-wire.bundle.mjs');
  await bundle({
    entryPoints: [entry], outfile: output, bundle: true, platform: 'node',
    target: 'node22', format: 'esm', nodePaths: [join(repo, 'extensions/engine-t3/node_modules')],
    plugins: [{
      name: 'pinned-t3-contracts',
      setup(builder) {
        const paths = {
          '@t3tools/contracts': 'packages/contracts/src/index.ts',
          '@t3tools/contracts/relay': 'packages/contracts/src/relay.ts',
          '@t3tools/client-runtime/rpc-protocol': 'packages/client-runtime/src/rpc/protocol.ts',
        };
        builder.onResolve({ filter: /^@t3tools\// }, (args) =>
          paths[args.path] ? { path: join(upstream, paths[args.path]) } : undefined);
      },
    }],
  });
  const script = spawn(process.execPath, [output], {
    windowsHide: true, cwd: join(repo, 'extensions/engine-t3'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...cleanEnv, T3_TEST_URL: url, T3_TEST_SESSION: session,
      T3_TEST_PROVIDER: providerId, T3_TEST_PROJECT: projectId,
      T3_TEST_WORKSPACE: join(temp, 'workspace'),
      T3_TEST_FAKE_ACP: join(repo, 'extensions/coding-workflow/test/second-acp.mjs'),
    },
  });
  const result = await capture(script);
  assert.match(result, /T3_ISOLATED_SETUP PASS/);
  assert.match(result, /P5-5_WIRE PASS/);
  console.log('P5-5_PINNED_WIRE PASS config=true switch=true worktree=true terminal=true');
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
  async type(selector, value) {
    const focused = await this.evaluate(`!!document.querySelector(${JSON.stringify(selector)}) && (document.querySelector(${JSON.stringify(selector)}).focus(), true)`);
    assert.ok(focused, 'input not found: ' + selector);
    await this.send('Input.insertText', { text: value }, this.session);
  }
  close() { this.socket.close(); }
}
async function buildFrontend() {
  const built = spawnSync(process.execPath, [join(app, 'node_modules/vite/bin/vite.js'), 'build'], {
    cwd: app, windowsHide: true, stdio: 'inherit',
  });
  assert.equal(built.status, 0, 'Vite must build the current tree first');
  const html = await readFile(join(app, 'dist/index.html'), 'utf8');
  const scripts = new Set();
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const attributes = Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*["']([^"']+)["']/g)]
      .map(([, key, value]) => [key.toLowerCase(), value]));
    if (tag.startsWith('<script') && attributes.type === 'module' && attributes.src) scripts.add(attributes.src);
    if (tag.startsWith('<link') && attributes.rel === 'modulepreload' && attributes.href) scripts.add(attributes.href);
  }
  assert.ok(scripts.size, 'missing Vite startup entry');
  const size = (await Promise.all([...scripts].map(async (path) =>
    gzipSync(await readFile(join(app, 'dist', path.replace(/^\//, '')))).length)))
    .reduce((sum, current) => sum + current, 0);
  assert.ok(size <= 300 * 1024, 'startup JavaScript exceeds 300 KB gzip: ' + size);
  console.log('P5-5_STARTUP_JS PASS gzip=' + size);
}
async function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else child.kill('SIGKILL');
}

async function main() {
  const temp = await mkdtemp(join(tmpdir(), 'nmh-p5-5-'));
  const state = join(temp, 't3-state');
  const saved = { NMH_T3_URL: process.env.NMH_T3_URL, NMH_T3_SCOPED_SESSION: process.env.NMH_T3_SCOPED_SESSION };
  let server, preview, viewer, gateway, control;
  const chrome = new HeadlessChromeProvider();
  let modelCalls = 0;
  const model = httpServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      assert.equal(req.headers.authorization, 'Bearer scripted-only-key');
      assert.equal(request.model, 'scripted-feature');
      modelCalls++;
      assert.ok(request.tools.some(t => t.function.name === 'write'), 'DSH sends real tool schemas');
      if (modelCalls > 1) {
        assert.ok(request.messages.some(m => m.role === 'tool' && m.tool_call_id === 'write-feature'), 'tool result retains call identity');
        assert.ok(request.messages.some(m => m.tool_calls?.some(c => c.id === 'write-feature')), 'assistant call retained');
      }
      const message = modelCalls === 1 ? { role: 'assistant', content: '', tool_calls: [{
        id: 'write-feature', type: 'function', function: { name: 'write',
          arguments: JSON.stringify({ file_path: 'feature.mjs', content: 'console.log("FEATURE_RUN_OK");\n' }) },
      }] } : { role: 'assistant', content: 'DSH feature file created. Ready for review.' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'scripted', choices: [{ index: 0, message,
        finish_reason: modelCalls === 1 ? 'tool_calls' : 'stop' }] }));
    } catch (error) { console.error('P5-5_MODEL_FAIL', String(error)); res.writeHead(500).end(String(error)); }
  });
  const git = (cwd, args) => {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  try {
    await new Promise(done => model.listen(0, '127.0.0.1', done));
    const port = await freePort();
    const t3Url = 'http://127.0.0.1:' + port;
    server = spawnT3(['serve', '--mode', 'desktop', '--host', '127.0.0.1', '--port', String(port),
      '--base-dir', state, '--no-browser'], state);
    await waitT3(t3Url, server);
    const scopedSession = await capture(spawnT3(['auth', 'session', 'issue', '--base-dir', state,
      '--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--scope', 'providers:manage',
      '--scope', 'terminal:read', '--scope', 'terminal:operate', '--scope', 'filesystem:read', '--scope', 'source-control:write',
      '--ttl', '15m', '--label', 'nmh-p5-5-isolated', '--token-only'], state));
    assert.match(await capture(spawnT3(['--version'], state)), /0\.1\.9\b/, 'installed T3 must match pinned v0.1.9');
    const dshVersion = JSON.parse(await readFile(join(repo, 'extensions/engine-dsh/node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version;
    assert.equal(dshVersion, JSON.parse(readFileSync(join(repo, 'upstream.lock.json'), 'utf8')).pins['deepseek-harness'].ref);
    const projectId = randomUUID();
    const secondProvider = 'scriptedSecond';
    await pinnedSetup(temp, t3Url, scopedSession, secondProvider, projectId);
    control = new T3ControlPlane();
    await control.connect(t3Url, scopedSession);
    const waitCompleted = async (id) => eventually(async () => {
      for await (const event of control.subscribeThread(id)) {
        if (event.kind !== 'snapshot') continue;
        const runs = event.payload.projection.runs;
        return runs.length > 0 && runs.every(r => r.status === 'completed');
      }
      return false;
    }, 'all thread runs completed', 60000);
    const root = join(temp, 'workspace');
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.name', 'Neo test']);
    git(root, ['config', 'user.email', 'test@localhost']);
    await writeFile(join(root, 'README.md'), 'Isolated feature repository\n');
    git(root, ['add', 'README.md']); git(root, ['commit', '-m', 'initial']);
    process.env.NMH_T3_URL = t3Url;
    process.env.NMH_T3_SCOPED_SESSION = scopedSession;
    gateway = await startGateway({ databaseFile: join(temp, 'neo.sqlite'), extensionsDir: join(repo, 'extensions'), mode: 'desktop', dataDir: temp });
    const base = 'http://127.0.0.1:' + gateway.port;
    const token = gateway.desktopToken;
    const rpc = createORPCClient(new RPCLink({ url: base, headers: { authorization: `Bearer ${token}` } }));
    assert.equal((await fetch(base + '/x/coding-workflow/register', { method: 'POST' })).status, 401);
    for (const id of ['sample-ts', 'models', 'engine-t3', 'engine-dsh', 'coding-workflow']) {
      const result = await rpc.extensions.enable({ id });
      assert.equal(result.status, 'running', id + ': ' + JSON.stringify(result));
    }
    await rpc.x.models.providers.put({ id: 'scripted', kind: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'scripted-only-key' });
    await rpc.x.models.roles.set({ role: 'coding', providerId: 'scripted', model: 'scripted-feature' });
    assert.equal((await rpc.x['coding-workflow'].register()).providerId, 'neo-coding');
    const threadId = randomUUID();
    await rpc.x['engine-t3'].create({ threadId, projectId, title: 'P5-5 feature', providerId: 'neo-coding', model: 'default' });

    const previewPort = await freePort();
    preview = spawn(process.execPath, [join(app, 'node_modules/vite/bin/vite.js'), 'preview',
      '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort'], { cwd: app, windowsHide: true, stdio: 'ignore' });
    await eventually(async () => (await fetch('http://127.0.0.1:' + previewPort + '/coding')).ok, 'Vite preview');
    await chrome.attach('viewer');
    viewer = await CDP.open(chrome.browser('viewer'));
    await viewer.navigate('http://127.0.0.1:' + previewPort + '/coding?gateway=' + encodeURIComponent(base) + '&token=' + encodeURIComponent(token));
    await eventually(() => viewer.evaluate(`!!document.querySelector('[data-testid="thread-${threadId}"]')`), 'feature thread visible');
    await viewer.evaluate(`document.querySelector('[data-testid="thread-${threadId}"]').click()`);
    await eventually(() => viewer.evaluate('!!document.querySelector("[data-testid=coding-workflow]")'), 'workflow panel');
    await viewer.evaluate('document.querySelector("[data-testid=coding-workflow]").open=true');
    const click = async (id) => {
      await eventually(() => viewer.evaluate(`(() => { const e=document.querySelector('[data-testid="${id}"]'); return e && !e.disabled && e.getAttribute('aria-disabled')!=='true'; })()`), id + ' enabled');
      await viewer.evaluate(`document.querySelector('[data-testid="${id}"]').click()`);
    };
    await viewer.type('[data-testid=workflow-branch]', 'neo/p5-5-feature');
    await click('workflow-worktree');
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=workflow-status]").textContent.includes("worktree")'), 'thread worktree');
    const worktree = await viewer.evaluate('document.querySelector("[data-testid=workflow-status]").textContent');
    assert.ok(existsSync(join(worktree, '.git')), worktree);
    assert.equal(git(worktree, ['branch', '--show-current']), 'neo/p5-5-feature');
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=coding-status]")?.textContent === "Ready"'), 'thread ready');
    await viewer.evaluate('document.querySelector(".coding-conversation [contenteditable=true]").focus()');
    await viewer.send('Input.insertText', { text: 'Build the feature by creating feature.mjs.' }, viewer.session);
    await viewer.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, viewer.session);
    await viewer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, viewer.session);
    await eventually(() => existsSync(join(worktree, 'feature.mjs')), 'DSH writes feature in thread worktree', 60000);
    assert.equal(await readFile(join(worktree, 'feature.mjs'), 'utf8'), 'console.log("FEATURE_RUN_OK");\n');
    await waitCompleted(threadId);
    assert.ok(modelCalls >= 2, 'real DSH loop executed write tool and resumed');

    await rpc.x['engine-t3'].send({ threadId, text: 'Confirm the feature is ready.' });
    await eventually(() => modelCalls >= 3, 'second DSH prompt uses the existing session');
    await waitCompleted(threadId);
    await rpc.x['coding-workflow'].switch({ threadId, providerId: secondProvider, model: 'default' });
    await rpc.x['engine-t3'].send({ threadId, text: 'Continue and review the feature built by DSH.' });
    await eventually(() => existsSync(join(worktree, 'provider-continuation.jsonl')), 'second provider ran in same worktree');
    await waitCompleted(threadId);
    const threads = (await rpc.x['engine-t3'].threads.list()).threads;
    assert.equal(threads.length, 1, 'switch continues same thread');
    assert.equal(threads[0].id, threadId);
    assert.match(await readFile(join(worktree, 'provider-continuation.jsonl'), 'utf8'), /Continue and review/);
    await click('workflow-terminal');
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=workflow-status]").textContent.includes("Terminal connected")'), 'terminal opened');
    await viewer.type('[data-testid=workflow-command]', 'node feature.mjs');
    await click('workflow-run');
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=workflow-output]").textContent.includes("FEATURE_RUN_OK")'), 'real terminal run output');
    const terminalSnapshot = (await rpc.x['coding-workflow'].terminal.open({ threadId })).snapshot;
    assert.ok(terminalSnapshot.pid > 0);
    await assert.rejects(rpc.x['coding-workflow'].prepare({ threadId, title: 'escape', description: '', files: ['../outside'] }));
    await viewer.type('[data-testid=workflow-title]', 'feat: add scripted feature');
    await viewer.type('[data-testid=workflow-files]', 'feature.mjs');
    await viewer.type('[data-testid=workflow-description]', 'Creates a feature with DSH, then reviews it on a second provider. Validated by node feature.mjs.');
    await click('workflow-prepare');
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=workflow-status]").textContent.startsWith("Prepared ")'), 'local PR prepared');
    const prepared = await viewer.evaluate('document.querySelector("[data-testid=workflow-status]").textContent');
    const commit = git(worktree, ['rev-parse', 'HEAD']);
    assert.ok(prepared.includes(commit));
    assert.equal(git(worktree, ['show', 'HEAD:feature.mjs']), 'console.log("FEATURE_RUN_OK");');
    const descriptionFile = prepared.split('; description: ')[1];
    assert.match(await readFile(descriptionFile, 'utf8'), /Validated by node feature.mjs/);
    assert.equal(git(root, ['remote', '-v']), '', 'no remote needed and no GitHub call');
    assert.ok(!existsSync(join(root, 'feature.mjs')), 'main checkout untouched');
    await rpc.extensions.disable({ id: 'engine-dsh' });
    await assert.rejects(rpc.x['coding-workflow'].register(), /DSH.*disabled/i);
    await assert.rejects(rpc.x['coding-workflow'].switch({ threadId, providerId: 'neo-coding', model: 'default' }), /DSH.*disabled/i);
    assert.equal((await fetch(base + '/x/sample-ts/hello', { headers: { authorization: `Bearer ${token}` } })).status, 200);
    await rpc.extensions.disable({ id: 'engine-t3' });
    await eventually(() => { try { process.kill(terminalSnapshot.pid, 0); return false; } catch { return true; } }, 'owned terminal process exits');
    await assert.rejects(rpc.x['coding-workflow'].terminal.open({ threadId }), /T3.*(disabled|disconnected)/i);
    assert.equal((await fetch(base + '/x/sample-ts/hello', { headers: { authorization: `Bearer ${token}` } })).status, 200);
    await rpc.extensions.disable({ id: 'coding-workflow' });
    assert.ok(!existsSync(join(temp, 'extensions/coding-workflow/acp.token')), 'IPC capability removed');
    await assert.rejects(rpc.x['coding-workflow'].register(), e => e.status === 404);
    console.log('P5-5_RUNTIME PASS node=' + process.version + ' t3=v0.1.9 dsh=' + dshVersion);
    console.log('P5-5_EXIT PASS authenticated=true build_first=true dsh_write=real_tool same_thread=switched terminal=run_output pr=local_commit_description disabled=handled sample=healthy');
  } catch (error) {
    console.error('P5-5_FAIL', error);
    if (control) { const catalog = await control.listThreads().catch(() => null); if (catalog?.threads?.[0]) { for await (const event of control.subscribeThread(catalog.threads[0].id)) { if (event.kind === 'snapshot') { const p=event.payload.projection; console.error('P5-5_RUN_DIAG', JSON.stringify({runs:p.runs, attempts:p.attempts, sessions:p.providerSessions}).slice(-5000)); break; } } } }
    if (viewer) console.error('P5-5_UI', await viewer.evaluate('JSON.stringify({workflow:document.querySelector("[data-testid=workflow-status]")?.textContent, status:document.querySelector("[data-testid=coding-status]")?.textContent, output:document.querySelector("[data-testid=workflow-output]")?.textContent?.slice(-2000),error:document.querySelector("[role=alert]")?.textContent})').catch(String));
    throw error;
  } finally {
    viewer?.close();
    await chrome.release('viewer').catch(() => {});
    await stopProcess(preview);
    await gateway?.close().catch(() => {});
    await control?.disconnect().catch(() => {});
    await stopProcess(server);
    await new Promise(done => model.close(done));
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
    // T3 worktrees live in its isolated base-dir; remove only this verified test root.
    await rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

await buildFrontend();
await main();
