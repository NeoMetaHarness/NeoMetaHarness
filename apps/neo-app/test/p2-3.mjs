import assert from 'node:assert/strict';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createInterface } from 'node:readline';
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

async function startGateway(dbFile, hermesHome, modelUrl) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: gatewayDir,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    env: { ...process.env, NMH_DB_PATH: dbFile, NMH_HERMES_HOME: hermesHome, NMH_HERMES_MODEL_URL: modelUrl, NMH_EXTENSIONS_DIR: join(repo, 'extensions'), NMH_PORT: '0', NEO_MODE: 'desktop', NEO_PRINT_DESKTOP_TOKEN: '1' },
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
  let token = '';
  const port = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gateway startup timed out: ${errors}`)), 20000);
    const lines = createInterface({ input: child.stdout });
    const success = (portNumber) => { clearTimeout(timer); lines.close(); done(portNumber); };
    const fail = (error) => { clearTimeout(timer); lines.close(); reject(error); };
    lines.on('line', (line) => {
      if (line.startsWith('NEO_DESKTOP_TOKEN ')) token = line.slice('NEO_DESKTOP_TOKEN '.length).trim();
      if (line.startsWith('GATEWAY_READY ')) {
        const payload = JSON.parse(line.slice('GATEWAY_READY '.length));
        if (payload.desktopToken) token = payload.desktopToken;
        success(payload.port);
      }
    });
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`Gateway exited ${code}: ${errors}`)));
  });
  return { port, token, child, errors: () => errors, async close() {
    if (child.exitCode !== null) return;
    const exit = new Promise((done) => child.once('exit', done));
    child.send('shutdown');
    await Promise.race([exit, sleep(10000).then(() => { throw new Error(`Gateway shutdown timeout: ${errors}`); })]);
    assert.equal(child.exitCode, 0, `Gateway shutdown error: ${errors}`);
  } };
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
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
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

async function verifyBuild() {
  nodeTool(uiDir, 'typescript/bin/tsc', ['--noEmit']);
  nodeTool(app, 'typescript/bin/tsc', ['--noEmit']);
  nodeTool(gatewayDir, 'typescript/bin/tsc', ['--noEmit']);
  nodeTool(app, 'vite/bin/vite.js', ['build']);
  const html = await readFile(join(app, 'dist', 'index.html'), 'utf8');
  const startup = new Set();
  const stylesheets = new Set();
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const attributes = Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*["']([^"']+)["']/g)]
      .map(([, key, value]) => [key.toLowerCase(), value]));
    const js = tag.startsWith('<script') && attributes.type === 'module' ||
      tag.startsWith('<link') && attributes.rel === 'modulepreload';
    const path = js ? (attributes.src ?? attributes.href) : attributes.rel === 'stylesheet' ? attributes.href : undefined;
    if (!path) continue;
    const url = new URL(path, 'http://localhost/');
    assert.equal(url.origin, 'http://localhost', `Unexpected remote startup asset ${path}`);
    if (js) startup.add(decodeURIComponent(url.pathname.slice(1)));
    else stylesheets.add(decodeURIComponent(url.pathname.slice(1)));
  }
  assert.ok(startup.size > 0, 'Vite build must include a startup JS entry');
  const measure = async (assets) => Promise.all([...assets].map(async (asset) => {
    const bytes = gzipSync(await readFile(join(app, 'dist', asset))).length;
    console.log(`P1-2_ASSET ${asset} gzip=${bytes}`);
    return bytes;
  }));
  const jsGzip = (await measure(startup)).reduce((a, b) => a + b, 0);
  const cssGzip = (await measure(stylesheets)).reduce((a, b) => a + b, 0);
  assert.ok(jsGzip <= 300 * 1024, `Startup JS exceeds 300 KiB (${jsGzip} bytes gzip across ${startup.size} assets)`);
  console.log(`P1-2_BUNDLE PASS startup_js_gzip=${jsGzip} css_gzip=${cssGzip} limit=${300 * 1024}`);
}

async function fakeModel() {
  const server = createHttpServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
      return;
    }
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      const messages = input.messages ?? [];
      const user = [...messages].reverse().find((item) => item.role === 'user');
      const text = String(user?.content ?? '');
      const toolDone = messages.some((item) => item.role === 'tool');
      const approval = text.includes('trigger_approval') && !toolDone;
      const slow = text.includes('trigger_stop') && !toolDone;
      const tool = {
        id: 'call_approval', type: 'function',
        function: { name: 'terminal', arguments: JSON.stringify({ command: 'rm -rf /tmp/danger_zone' }) },
      };
      const message = approval
        ? { role: 'assistant', content: 'Requesting permission', tool_calls: [tool] }
        : { role: 'assistant', content: toolDone ? 'Permission declined. Run complete.' : 'Hermes fake answer complete.' };
      if (!input.stream) {
        if (slow) await sleep(20000);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'fake-completion', object: 'chat.completion', model: 'fake-model',
          choices: [{ index: 0, message, finish_reason: approval ? 'tool_calls' : 'stop' }],
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (delta, finish_reason = null) => {
        const chunk = {
          id: 'fake-completion', object: 'chat.completion.chunk',
          created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason }],
        };
        if (!res.destroyed) res.write('data: ' + JSON.stringify(chunk) + '\n\n');
      };
      send({ role: 'assistant', content: '' });
      if (slow) {
        send({ content: 'Starting long task. ' });
        await sleep(20000);
      } else if (approval) {
        send({ content: 'Hello ' });
        send({ content: 'from ' });
        send({ content: 'Hermes.' });
        send({ tool_calls: [{ index: 0, ...tool }] });
      } else {
        for (const piece of ['Permission ', 'declined. ', 'Run complete.']) send({ content: piece });
      }
      send({}, approval ? 'tool_calls' : 'stop');
      if (!res.destroyed) res.end('data: [DONE]\n\n');
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, port: address.port };
}

async function trial(previewPort) {
  const temporary = await mkdtemp(join(tmpdir(), 'nmh-p2-3-'));
  const model = await fakeModel();
  let gateway;
  let chrome;
  try {
    gateway = await startGateway(join(temporary, 'state.sqlite'),
      join(temporary, 'hermes-home'), 'http://127.0.0.1:' + model.port + '/v1');
    const base = 'http://127.0.0.1:' + gateway.port;
    const rpc = createORPCClient(new RPCLink({ url: base, headers: { authorization: 'Bearer ' + gateway.token } }));
    assert.equal((await rpc.extensions.enable({ id: 'sample-ts' })).status, 'running');
    const enabled = await rpc.extensions.enable({ id: 'engine-hermes' });
    assert.equal(enabled.status, 'running', enabled.reason);
    const url = `http://127.0.0.1:${previewPort}/agents?gateway=${encodeURIComponent(base)}&token=${encodeURIComponent(gateway.token)}`;
    chrome = await startChrome(join(temporary, 'chrome'));
    const page = await pageSession(chrome, url);
    try {
      await page.eventually('!!document.querySelector("[data-testid=agents-page]")', 'lazy Agents page');
      await page.eventually('!!document.querySelector("[data-testid=bot-default]")', 'Hermes default bot list');
      await page.evaluate(`(() => {
        const input = document.querySelector('[data-testid=bot-name]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'neo_ui');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await page.eventually('!document.querySelector(".agents-create button[type=submit]").disabled', 'create action enabled');
      await page.evaluate('document.querySelector(".agents-create button[type=submit]").click()');
      await page.eventually('!!document.querySelector("[data-testid=bot-neo_ui]")', 'new bot in list');
      await page.eventually('document.querySelector(".agents-conversation-title h2")?.textContent === "neo_ui"', 'new bot opened');
      console.log('P2-3_STAGE bot created');

      async function writeAndSend(text) {
        await page.eventually('!!(document.querySelector(".agents-conversation [contenteditable=true]") || document.querySelector(".agents-conversation textarea"))', 'Astryx chat composer');
        await page.evaluate(`(() => {
          const input = document.querySelector('.agents-conversation [contenteditable=true]') ||
            document.querySelector('.agents-conversation textarea');
          input.focus();
        })()`);
        await page.typeText(text);
        await page.pressEnter();
      }

      await writeAndSend('trigger_approval clean temp directory');
      console.log('P2-3_STAGE approval prompt submitted');
      await page.eventually('document.querySelector(".agents-stream")?.textContent?.includes("Hello from Hermes")', 'streamed text');
      console.log('P2-3_STAGE text streamed');
      await page.eventually('!!document.querySelector("[data-testid=approval-card]")', 'approval card');
      console.log('P2-3_STAGE approval card shown');
      await page.evaluate('document.querySelector("[data-testid=approval-deny]").click()');
      await page.eventually('document.querySelector("[data-testid=agents-status]")?.textContent === "Completed"', 'approved run completed after denial');
      console.log('P2-3_STAGE denial completed');
      await page.eventually('document.querySelector(".agents-stream")?.textContent?.includes("Permission declined")', 'final stream content');
      await writeAndSend('trigger_stop slow model answer');
      await page.eventually('document.querySelector("[data-testid=agents-status]")?.textContent === "Running" && !!document.querySelector("[data-testid=stop-run]")', 'second run started');
      await page.evaluate('document.querySelector("[data-testid=stop-run]").click()');
      await page.eventually('document.querySelector("[data-testid=agents-status]")?.textContent === "Cancelled"', 'run stopped in terminal state');
      console.log('P2-3_STAGE second run stopped');
      await page.eventually('!document.querySelector("[data-testid=stop-run]")', 'stream teardown after stopping');
      await page.evaluate('document.querySelector("[data-testid=delete-neo_ui]").click()');
      await page.eventually('!document.querySelector("[data-testid=bot-neo_ui]")', 'bot deleted');
      assert.ok(!(await rpc.x['engine-hermes'].profiles.list()).profiles.some((p) => p.name === 'neo_ui'));
      await rpc.extensions.disable({ id: 'engine-hermes' });
      assert.equal((await fetch(base + '/x/engine-hermes/profiles/list', { headers: { authorization: 'Bearer ' + gateway.token } })).status, 404);
      assert.equal((await fetch(base + '/x/sample-ts/hello', { headers: { authorization: 'Bearer ' + gateway.token } })).status, 200);
      console.log('P2-3_BROWSER PASS create=true streamed=true approval=deny completed=true stop=cancelled delete=true disabled=404 sample=healthy');
    } catch (error) {
      console.error('P2-3_BROWSER FAILURE', error, 'GATEWAY ERRORS', gateway?.errors());
      throw error;
    } finally {
      await page.close();
    }
  } finally {
    chrome?.close();
    if (gateway) await gateway.close();
    model.server.closeAllConnections();
    await new Promise((done) => model.server.close(done));
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

await verifyBuild();
const port = await freePort();
const preview = spawn(process.execPath, [join(app, 'node_modules', 'vite', 'bin', 'vite.js'),
  'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: app, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
try {
  await awaitHttp(`http://127.0.0.1:${port}/agents`, 'Vite preview');
  await trial(port);
  console.log('P2-3_EXIT PASS');
} finally {
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(preview.pid), '/T', '/F'], { windowsHide: true });
  else preview.kill();
}
