import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedT3Environment } from '../../../extensions/engine-t3/src/runtime.ts';
import { pinnedTestT3Cli } from '../../../extensions/engine-t3/test/pinned-cli.ts';
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
function spawnT3(cli, args, cwd, env) {
  return spawn(cli, args, {
    cwd, env,
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
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
  const entry = join(repo, 'extensions/engine-t3/test/wire.entry.ts');
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
      T3_TEST_FAKE_ACP: join(repo, 'spikes/P0-3a-t3-headless-client/fake-acp.mjs'),
    },
  });
  const result = await capture(script);
  assert.match(result, /T3_ISOLATED_SETUP PASS/);
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
  async type(selector, value) {
    const focused = await this.evaluate(`!!document.querySelector(${JSON.stringify(selector)}) && (document.querySelector(${JSON.stringify(selector)}).focus(), true)`);
    assert.ok(focused, 'input not found: ' + selector);
    await this.send('Input.insertText', { text: value }, this.session);
  }
  close() { /* the provider owns the pipe; release() closes it */ }
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
  console.log('P5-2_STARTUP_JS PASS gzip=' + size);
}
async function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else child.kill('SIGKILL');
}
async function main() {
  const temp = await mkdtemp(join(tmpdir(), 'nmh-p5-2-'));
  const savedUrl = process.env.NMH_T3_URL;
  const savedSession = process.env.NMH_T3_SCOPED_SESSION;
  let server, preview, viewer, gateway;
  const chrome = new HeadlessChromeProvider();
  try {
    const environment = await isolatedT3Environment(join(temp, 't3-state'));
    const executable = await pinnedTestT3Cli('P5-2', repo, temp, environment);
    if (!executable) return;
    const state = environment.T3CODE_HOME;
    const port = await freePort();
    const t3Url = 'http://127.0.0.1:' + port;
    server = spawnT3(executable, ['serve', '--mode', 'desktop', '--host', '127.0.0.1', '--port', String(port),
      '--base-dir', state, '--no-browser'], temp, environment);
    await waitT3(t3Url, server);
    const scopedSession = await capture(spawnT3(executable, ['auth', 'session', 'issue', '--base-dir', state,
      '--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--scope', 'providers:manage',
      '--ttl', '15m', '--label', 'nmh-p5-2-isolated', '--token-only'], temp, environment));
    assert.ok(scopedSession.length > 16, 'scoped session issuance');
    const providerId = 'nmhFakeAcp';
    const projectId = randomUUID();
    await pinnedSetup(temp, t3Url, scopedSession, providerId, projectId);
    process.env.NMH_T3_URL = t3Url;
    process.env.NMH_T3_SCOPED_SESSION = scopedSession;
    gateway = await startGateway({ databaseFile: join(temp, 'neo.sqlite'), extensionsDir: join(repo, 'extensions'), mode: 'desktop', dataDir: temp });
    const token = gateway.desktopToken;
    const base = 'http://127.0.0.1:' + gateway.port;
    const rpc = createORPCClient(new RPCLink({ url: base, headers: { authorization: `Bearer ${token}` } }));
    assert.equal((await rpc.extensions.enable({ id: 'sample-ts' })).status, 'running');
    assert.equal((await rpc.extensions.enable({ id: 'engine-t3' })).status, 'running');
    assert.ok((await rpc.x['engine-t3'].threads.list()).projects.some((entry) => entry.id === projectId));
    const previewPort = await freePort();
    preview = spawn(process.execPath, [join(app, 'node_modules/vite/bin/vite.js'), 'preview',
      '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort'],
      { cwd: app, windowsHide: true, stdio: 'ignore' });
    await eventually(async () => (await fetch('http://127.0.0.1:' + previewPort + '/coding')).ok, 'Vite preview');
    await chrome.attach('viewer');
    viewer = await CDP.open(chrome.browser('viewer'));
    await viewer.navigate('http://127.0.0.1:' + previewPort + '/coding?gateway=' + encodeURIComponent(base) + '&token=' + encodeURIComponent(token));
    await eventually(() => viewer.evaluate('!!document.querySelector("[data-testid=coding-page]")'), 'lazy-loaded Coding route');
    await eventually(() => viewer.evaluate('!!document.querySelector("[data-testid=coding-title]")'), 'isolated T3 project visible');
    await viewer.type('[data-testid=coding-title]', 'P5-2 isolated thread');
    await viewer.evaluate(`(() => {
      const select = document.querySelector('[data-testid=coding-provider]');
      select.value = '${providerId}';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=coding-provider]")?.value === "nmhFakeAcp"'),
      'scripted provider selected');
    console.log('P5-2_CREATE_FORM', await viewer.evaluate(`JSON.stringify({
      title: document.querySelector('[data-testid=coding-title]')?.value,
      provider: document.querySelector('[data-testid=coding-provider]')?.value,
      model: document.querySelector('[data-testid=coding-model]')?.value,
      disabled: (document.querySelector('.coding-create button[type=submit]')?.disabled || document.querySelector('.coding-create button[type=submit]')?.getAttribute("aria-disabled") === "true")
    })`));
    await viewer.evaluate('document.querySelector(".coding-create button[type=submit]").click()');
    try {
      await eventually(() => viewer.evaluate('document.querySelector("[data-testid=coding-status]")?.textContent === "Ready" && !!document.querySelector(".coding-conversation [contenteditable=true]")'), 'new thread subscribed', 20000);
    } catch (error) {
      console.log('P5-2_CREATE_DIAGNOSTIC', await viewer.evaluate(`JSON.stringify({
        status: document.querySelector('[data-testid=coding-status]')?.textContent,
        alert: document.querySelector('[role=alert]')?.textContent,
        content: document.querySelector('.coding-conversation')?.innerText?.slice(0, 900),
        disabled: (document.querySelector('.coding-create button[type=submit]')?.disabled || document.querySelector('.coding-create button[type=submit]')?.getAttribute("aria-disabled") === "true")
      })`));
      console.log('P5-2_REMOTE_THREADS', (await rpc.x['engine-t3'].threads.list()).threads.length);
      throw error;
    }
    const listed = await rpc.x['engine-t3'].threads.list();
    assert.ok(listed.threads.some((entry) => entry.title === 'P5-2 isolated thread'), 'create thread through browser');
    const conversation = async () => viewer.evaluate('document.querySelector(".coding-conversation")?.innerText ?? ""');
    const send = async (prompt) => {
      await viewer.type('.coding-conversation [contenteditable=true]', prompt);
      const available = await viewer.evaluate('Array.from(document.querySelectorAll(".coding-conversation button")).map(b => ({text:b.textContent,aria:b.getAttribute("aria-label"),type:b.type,disabled:b.disabled}))');
      const action = await viewer.evaluate('!!document.querySelector(".coding-conversation form")');
      if (action) await viewer.evaluate('document.querySelector(".coding-conversation form").requestSubmit()');
      else {
        await viewer.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, viewer.session);
        await viewer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, viewer.session);
      }
      await eventually(() => viewer.evaluate('document.querySelector("[data-testid=coding-status]")?.textContent === "Running" || !!document.querySelector("[data-testid=coding-approval]")'), 'prompt accepted ' + JSON.stringify(available));
    };
    await send('First fake prompt: please request permission.');
    await eventually(() => viewer.evaluate('!!document.querySelector("[data-testid=coding-deny]")'), 'deny approval card');
    await eventually(async () => (await conversation()).includes('neo fake streamed text, part two.'), 'streamed text via StreamView');
    await viewer.evaluate('document.querySelector("[data-testid=coding-deny]").click()');
    await eventually(async () => (await conversation()).includes('Approval declined.'), 'declined fake ACP response');
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=coding-status]")?.textContent === "completed"'), 'first turn completed');
    await send('Second fake prompt: approve permission.');
    await eventually(() => viewer.evaluate('!!document.querySelector("[data-testid=coding-approve]")'), 'approve approval card');
    await viewer.evaluate('document.querySelector("[data-testid=coding-approve]").click()');
    try {
      await eventually(async () => (await conversation()).includes('Approval was not declined.'), 'approved fake ACP response', 18000);
    } catch (error) {
      console.log('P5-2_APPROVAL_DIAGNOSTIC', JSON.stringify({
        conversation: await conversation(),
        status: await viewer.evaluate('document.querySelector("[data-testid=coding-status]")?.textContent'),
        error: await viewer.evaluate('document.querySelector("[role=alert]")?.textContent'),
      }));
      throw error;
    }
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=coding-status]")?.textContent === "completed"'), 'second turn completed');
    await viewer.evaluate('document.querySelector("[data-testid=coding-diff]").click()');
    await eventually(() => viewer.evaluate('!!document.querySelector("[data-testid=coding-diff-result]")'), 'diff outcome visible');
    await viewer.evaluate('document.querySelector("[data-testid=coding-settle]").click()');
    await eventually(() => viewer.evaluate('document.querySelector("[data-testid=coding-status]")?.textContent === "Settled" || document.querySelector("[data-testid=coding-status]")?.textContent === "Settling"'), 'settle UI');
    await rpc.extensions.disable({ id: 'engine-t3' });
    try {
      await eventually(() => viewer.evaluate('!!document.querySelector("[data-testid=coding-disabled]")'), 'disabled Coding page', 15000);
    } catch (error) {
      const remote = await rpc.x['engine-t3'].threads.list().then(
        (result) => ({ available: true, result }),
        (reason) => ({ available: false, message: String(reason), code: reason.code, status: reason.status }),
      );
      console.log('P5-2_DISABLED_DIAGNOSTIC', JSON.stringify({
        remote,
        status: await viewer.evaluate('document.querySelector("[data-testid=coding-status]")?.textContent'),
        error: await viewer.evaluate('document.querySelector("[role=alert]")?.textContent'),
        extension: (await rpc.extensions.list()).find((entry) => entry.id === 'engine-t3'),
      }));
      throw error;
    }
    assert.equal((await fetch(base + '/x/sample-ts/hello', { headers: { authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await rpc.extensions.list()).find((entry) => entry.id === 'sample-ts')?.status, 'running');
    console.log('P5-2_GATEWAY_UI PASS project=list thread=create prompts=2 stream=visible approvals=deny+approve settled=true disabled=true sample=healthy');
    return true;
  } finally {
    viewer?.close();
    await chrome.release('viewer');
    await stopProcess(preview);
    await gateway?.close();
    await stopProcess(server);
    if (savedUrl === undefined) delete process.env.NMH_T3_URL;
    else process.env.NMH_T3_URL = savedUrl;
    if (savedSession === undefined) delete process.env.NMH_T3_SCOPED_SESSION;
    else process.env.NMH_T3_SCOPED_SESSION = savedSession;
    await rm(temp, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 });
  }
}
await buildFrontend();
if (await main()) console.log('P5-2_EXIT PASS');
