import assert from 'node:assert/strict';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
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

async function startGateway(dbFile) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: gatewayDir,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    env: { ...process.env, NMH_DB_PATH: dbFile, NMH_EXTENSIONS_DIR: join(repo, 'extensions'), NMH_PORT: '0' },
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
  const port = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gateway startup timed out: ${errors}`)), 20000);
    const lines = createInterface({ input: child.stdout });
    const success = (portNumber) => { clearTimeout(timer); lines.close(); done(portNumber); };
    const fail = (error) => { clearTimeout(timer); lines.close(); reject(error); };
    lines.on('line', (line) => {
      if (line.startsWith('GATEWAY_READY ')) success(JSON.parse(line.slice('GATEWAY_READY '.length)).port);
    });
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`Gateway exited ${code}: ${errors}`)));
  });
  return { port, child, async close() {
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
    for (let retry = 0; retry < 160; retry++) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw new Error(`Browser never observed ${description}. DOM=${(await evaluate('document.body?.innerText'))?.slice(0, 700)}`);
  };
  return {
    evaluate,
    eventually,
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
  const entry = html.match(/src="\/(assets\/index-[^"]+\.js)"/)?.[1];
  assert.ok(entry, 'Vite build must include an initial JS entry');
  const gzip = gzipSync(await readFile(join(app, 'dist', entry))).length;
  assert.ok(gzip <= 300 * 1024, `Initial chunk ${entry} exceeds 300 KiB (${gzip} bytes gzip)`);
  console.log(`P1-2_BUNDLE PASS initial=${entry} gzip=${gzip} limit=${300 * 1024}`);
}

async function trial(number, previewPort) {
  const temporary = await mkdtemp(join(tmpdir(), `nmh-p1-2-${number}-`));
  let gateway;
  let chrome;
  try {
    gateway = await startGateway(join(temporary, 'state.sqlite'));
    const base = `http://127.0.0.1:${gateway.port}`;
    const rpc = createORPCClient(new RPCLink({ url: base }));
    const listed = await rpc.extensions.list();
    const expectedRows = listed.length;
    assert.ok(['sample-ts', 'sample-py'].every((id) => listed.some((row) => row.id === id)), 'Both sample extensions are discoverable');
    assert.equal((await rpc.extensions.enable({ id: 'sample-ts' })).status, 'running');
    assert.equal((await rpc.extensions.enable({ id: 'sample-py' })).status, 'running');
    assert.equal((await fetch(`${base}/x/sample-ts/hello`)).status, 200);
    assert.equal((await fetch(`${base}/x/sample-py/hello`)).status, 200);

    const pageUrl = `http://127.0.0.1:${previewPort}/extensions?gateway=${encodeURIComponent(base)}`;
    chrome = await startChrome(join(temporary, 'chrome'));
    const page = await pageSession(chrome, pageUrl);
    try {
      await page.eventually(`document.querySelectorAll("[data-testid^=extension-]").length === ${expectedRows}`, `${expectedRows} extension rows`);
      await page.eventually('document.body.innerText.includes("Inbox") && document.body.innerText.includes("Agents") && document.body.innerText.includes("Coding") && document.body.innerText.includes("Computers") && document.body.innerText.includes("Skills") && document.body.innerText.includes("Settings")', 'seven navigation entries');
      await page.eventually('document.querySelector("[data-testid=extension-sample-ts]")?.getAttribute("data-event-seq") === "1"', 'replayed TS event');
      await page.eventually('document.querySelector(".connection")?.textContent === "Live"', 'live stream');
      assert.equal(await page.evaluate('document.querySelector("[data-testid=extension-sample-ts] input[type=checkbox]")?.checked'), true);
      assert.equal(await page.evaluate('document.querySelector("[data-testid=extension-sample-py] input[type=checkbox]")?.checked'), true);
      if (number === 1 && process.env.NMH_P1_2_SCREENSHOT) await page.screenshot(process.env.NMH_P1_2_SCREENSHOT);

      assert.equal(await page.evaluate('document.querySelector("[data-testid=extension-sample-ts] input[type=checkbox]").click(); true'), true);
      await page.eventually('document.querySelector("[data-testid=extension-sample-ts]")?.getAttribute("data-event-seq") === "3" && !document.querySelector("[data-testid=extension-sample-ts] input[type=checkbox]").checked', 'TS disabled from event seq 3');
      assert.equal((await fetch(`${base}/x/sample-ts/hello`)).status, 404);
      assert.equal((await fetch(`${base}/x/sample-py/hello`)).status, 200);

      assert.equal(await page.evaluate('document.querySelector("[data-testid=extension-sample-ts] input[type=checkbox]").click(); true'), true);
      await page.eventually('document.querySelector("[data-testid=extension-sample-ts]")?.getAttribute("data-event-seq") === "4" && document.querySelector("[data-testid=extension-sample-ts] input[type=checkbox]").checked', 'TS reenabled from event seq 4');
      assert.equal((await fetch(`${base}/x/sample-ts/hello`)).status, 200);
      assert.equal((await fetch(`${base}/x/sample-py/hello`)).status, 200);
      console.log(`P1-2_BROWSER PASS trial=${number} rows=${expectedRows} event_seq=1,3,4 off=404 on=200 python=200`);
    } finally { await page.close(); }
  } finally {
    chrome?.close();
    if (gateway) await gateway.close();
    await rm(temporary, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
  }
}

await verifyBuild();
const port = await freePort();
const preview = spawn(process.execPath, [join(app, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: app, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let previewErrors = '';
preview.stderr.on('data', (buffer) => { previewErrors += buffer.toString(); });
try {
  await awaitHttp(`http://127.0.0.1:${port}/extensions`, 'Vite preview');
  assert.equal((await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/sw.js`)).status, 200);
  await trial(1, port);
  await trial(2, port);
  console.log('P1-2_EXIT PASS trials=2 typecheck=3 pwa=200');
} finally {
  preview.kill();
  if (previewErrors) console.log(`Preview stderr: ${previewErrors.slice(0, 300)}`);
}
