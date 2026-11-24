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
  nodeTool(join(repo, 'extensions', 'engine-superagent'), 'typescript/bin/tsc', ['--noEmit']);
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
    console.log(`P5-3_ASSET ${asset} gzip=${bytes}`);
    return bytes;
  }));
  const jsGzip = (await measure(startup)).reduce((a, b) => a + b, 0);
  const cssGzip = (await measure(stylesheets)).reduce((a, b) => a + b, 0);
  assert.ok(jsGzip <= 300 * 1024, `Startup JS exceeds 300 KiB (${jsGzip} bytes gzip across ${startup.size} assets)`);
  console.log(`P5-3_BUNDLE PASS startup_js_gzip=${jsGzip} css_gzip=${cssGzip} limit=${300 * 1024}`);
}

async function fakeHermesModel() {
  const seen = [];
  let release = () => {};
  const barrier = new Promise((done) => { release = done; });
  const server = createHttpServer(async (req, res) => {
    if (req.url === '/v1/models') {
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
      const prompt = String([...input.messages ?? []].reverse().find((message) => message.role === 'user')?.content ?? '');
      seen.push(prompt);
      if (prompt.includes('hold_for_disable')) await barrier;
      else await sleep(400); // Keep the live Running state observable through Chrome.
      const text = 'Hermes fake answer complete.';
      if (!input.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', model: 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
        return;
      }
      const chunk = (delta, finish_reason) => ({ id: 'fake', object: 'chat.completion.chunk',
        created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason }] });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: ' + JSON.stringify(chunk({ role: 'assistant', content: text }, null)) + '\n\n');
      res.end('data: ' + JSON.stringify(chunk({}, 'stop')) + '\n\ndata: [DONE]\n\n');
    } catch (error) { if (!res.destroyed) res.writeHead(500).end(String(error)); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, port: address.port, seen, release };
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

async function trial(previewPort) {
  const temporary = await mkdtemp(join(tmpdir(), 'nmh-p5-3-'));
  const hermes = await fakeHermesModel();
  const dsh = await fakeDshModel();
  let gateway;
  let chrome;
  let page;
  try {
    gateway = await startGateway(join(temporary, 'state.sqlite'),
      join(temporary, 'hermes-home'), `http://127.0.0.1:${hermes.port}/v1`, `http://127.0.0.1:${dsh.port}`);
    const base = `http://127.0.0.1:${gateway.port}`;
    const rpc = createORPCClient(new RPCLink({ url: base, headers: authHeaders }));
    assert.equal((await rpc.extensions.enable({ id: 'sample-ts' })).status, 'running');
    const engine = await rpc.extensions.enable({ id: 'engine-hermes' });
    assert.equal(engine.status, 'running', engine.reason ?? gateway.errors());
    const superagent = await rpc.extensions.enable({ id: 'engine-superagent' });
    assert.equal(superagent.status, 'running', superagent.reason ?? gateway.errors());
    const bot = await rpc.agents.bots.create({ name: 'Neo Inbox Test Agent' });

    chrome = await startChrome(join(temporary, 'chrome'));
    page = await pageSession(chrome, `http://127.0.0.1:${previewPort}/inbox?gateway=${encodeURIComponent(base)}&token=${encodeURIComponent(AUTH)}`);
    await page.eventually('document.querySelector(".inbox-page") && document.querySelector(".connection")?.textContent === "Live"', 'Inbox lazy page and event stream');
    await page.eventually(`document.querySelector('input[name="inbox-agent"]')?.value === '${bot.id}'`, 'bot selector');
    assert.equal(await page.evaluate('document.querySelector("[role=radio][aria-checked=true][data-value]")?.dataset.value'), 'observe');

    async function submit(prompt, mode) {
      await page.evaluate(`document.querySelector('[role="radio"][data-value="${mode}"]').click()`);
      await page.evaluate(`(() => {
        const input = document.querySelector('#inbox-prompt');
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(prompt)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await page.eventually('!(document.querySelector(".inbox-composer button[type=submit]")?.disabled || document.querySelector(".inbox-composer button[type=submit]")?.getAttribute("aria-disabled") === "true")', 'Ask Neo submit ready');
      await page.evaluate('document.querySelector(".inbox-composer button[type=submit]").click()');
      await page.eventually(`!![...document.querySelectorAll('.inbox-item')].find(row => row.querySelector('.inbox-request')?.textContent === ${JSON.stringify(prompt)})`, 'Inbox ticket created');
    }

    const actPrompt = 'Act on this Inbox request';
    await submit(actPrompt, 'act');
    await page.eventually(`!![...document.querySelectorAll('.inbox-item[data-status="running"]')].find(row => row.querySelector('.inbox-request')?.textContent === ${JSON.stringify(actPrompt)})`, 'live act Running status');
    await page.eventually(`!![...document.querySelectorAll('.inbox-item[data-status="ready"]')].find(row => row.querySelector('.inbox-request')?.textContent === ${JSON.stringify(actPrompt)} && row.querySelector('.inbox-summary')?.textContent === 'Hermes fake answer complete.')`, 'act report card');
    assert.ok(await page.evaluate('document.body.textContent.includes("Tests run") && document.body.textContent.includes("Risks")'));
    console.log('P5-3_STAGE act live=running->ready report=visible');

    const observePrompt = 'Observe this Inbox request';
    await submit(observePrompt, 'observe');
    await page.eventually(`!![...document.querySelectorAll('.inbox-item[data-status="suggestion"]')].find(row => row.querySelector('.inbox-request')?.textContent === ${JSON.stringify(observePrompt)} && row.querySelector('[data-action=accept]'))`, 'observe Suggestion and Accept');
    await page.evaluate(`(() => {
      const row = [...document.querySelectorAll('.inbox-item')].find(row => row.querySelector('.inbox-request')?.textContent === ${JSON.stringify(observePrompt)});
      row.querySelector('[data-action=accept]').click();
    })()`);
    await page.eventually(`!![...document.querySelectorAll('.inbox-item[data-status="ready"]')].find(row => row.querySelector('.inbox-request')?.textContent === ${JSON.stringify(observePrompt)} && row.querySelector('.inbox-report'))`, 'accepted suggestion ready report');
    console.log('P5-3_STAGE observe suggestion->accept->ready');

    const blockedPrompt = 'hold_for_disable';
    await submit(blockedPrompt, 'act');
    await page.eventually(`!![...document.querySelectorAll('.inbox-item[data-status="running"]')].find(row => row.querySelector('.inbox-request')?.textContent === ${JSON.stringify(blockedPrompt)})`, 'mid-flight Running');
    for (let retry = 0; !hermes.seen.some((prompt) => prompt.includes(blockedPrompt)); retry++) {
      if (retry >= 650) throw new Error('Hermes never received mid-flight turn');
      await sleep(100);
    }
    await rpc.extensions.disable({ id: 'engine-hermes' });
    hermes.release();
    await page.eventually(`!![...document.querySelectorAll('.inbox-item[data-status="blocked"]')].find(row => row.querySelector('.inbox-request')?.textContent === ${JSON.stringify(blockedPrompt)} && row.querySelector('.inbox-blocked')?.textContent)`, 'blocked item with reason');
    console.log('P5-3_STAGE hermes=disabled ticket=blocked reason=visible');

    await rpc.extensions.disable({ id: 'engine-superagent' });
    await page.eventually('!!document.querySelector("[data-testid=inbox-disabled]")', 'Inbox extension-disabled state');
    assert.equal((await fetch(base + '/x/sample-ts/hello', { headers: authHeaders() })).status, 200, 'unrelated extension healthy');
    console.log(`P5-3_BROWSER PASS act=ready observe=ready blocked=reason disabled=visible other_extension=healthy hermes_requests=${hermes.seen.length} dsh_worker=${dsh.seen.length}`);

    assert.equal((await rpc.extensions.enable({ id: 'engine-hermes' })).status, 'running');
    assert.equal((await rpc.extensions.enable({ id: 'engine-superagent' })).status, 'running');
    await page.eventually('!document.querySelector("[data-testid=inbox-disabled]") && document.querySelector(".connection")?.textContent === "Live"', 'Inbox stream after re-enable');
    await submit('Act after re-enable', 'act');
    await page.eventually('!![...document.querySelectorAll(".inbox-item[data-status=ready]")].find(row => row.querySelector(".inbox-request")?.textContent === "Act after re-enable")', 're-enabled extension live report');
    console.log('P5-3_STAGE superagent=re-enabled live=ready');
  } catch (error) {
    console.error('P5-3_BROWSER FAILURE', error, 'GATEWAY STDERR', gateway?.errors());
    throw error;
  } finally {
    hermes.release();
    if (page) await page.close();
    chrome?.close();
    if (gateway) await gateway.close();
    for (const server of [hermes.server, dsh.server]) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
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
  await awaitHttp(`http://127.0.0.1:${port}/inbox`, 'Vite preview');
  await trial(port);
  console.log('P5-3_EXIT PASS');
} finally {
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(preview.pid), '/T', '/F'], { windowsHide: true });
  else preview.kill();
}
