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
    env: {
      ...process.env,
      NMH_DB_PATH: dbFile,
      NMH_EXTENSIONS_DIR: join(repo, 'extensions'),
      NMH_PORT: '0',
      NEO_MODE: 'desktop',
      NEO_PRINT_DESKTOP_TOKEN: '1',
    },
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
  let token = '';
  const port = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gateway startup timed out: ${errors}`)), 30000);
    const lines = createInterface({ input: child.stdout });
    const success = (portNumber) => { clearTimeout(timer); lines.close(); done(portNumber); };
    const fail = (error) => { clearTimeout(timer); lines.close(); reject(error); };
    lines.on('line', (line) => {
      if (line.startsWith('NEO_DESKTOP_TOKEN ')) token = line.slice('NEO_DESKTOP_TOKEN '.length).trim();
      if (line.startsWith('GATEWAY_READY ')) {
        const payload = JSON.parse(line.slice('GATEWAY_READY '.length));
        if (payload.token) token = payload.token;
        success(payload.port);
      }
    });
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`Gateway exited ${code}: ${errors}`)));
  });
  return {
    port,
    token,
    child,
    async close() {
      if (child.exitCode !== null) return;
      const exit = new Promise((done) => child.once('exit', done));
      child.send('shutdown');
      await Promise.race([
        exit,
        sleep(10000).then(() => {
          throw new Error(`Gateway shutdown timeout: ${errors}`);
        }),
      ]);
      assert.equal(child.exitCode, 0, `Gateway shutdown error: ${errors}`);
    },
  };
}

async function startChrome(profile) {
  const child = spawn(
    chromeBinary,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true }
  );
  let port;
  for (let retry = 0; retry < 100; retry++) {
    try {
      port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      break;
    } catch {
      if (child.exitCode !== null) throw new Error(`Chrome exited ${child.exitCode}`);
      await sleep(100);
    }
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
  const send = (method, params = {}, sessionId) =>
    new Promise((done, reject) => {
      const id = ++next;
      pending.set(id, (message) =>
        message.error ? reject(new Error(`${method}: ${message.error.message}`)) : done(message.result)
      );
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  return {
    child,
    socket,
    send,
    close() {
      socket.close();
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill();
    },
  };
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
    if (result.exceptionDetails) {
      throw new Error(`Browser exception: ${result.exceptionDetails.text} ${result.result?.description ?? ''}`);
    }
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
    async close() {
      await chrome.send('Target.closeTarget', { targetId });
    },
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
    const attributes = Object.fromEntries(
      [...tag.matchAll(/([\w-]+)\s*=\s*["']([^"']+)["']/g)].map(([, key, value]) => [key.toLowerCase(), value])
    );
    const js =
      (tag.startsWith('<script') && attributes.type === 'module') ||
      (tag.startsWith('<link') && attributes.rel === 'modulepreload');
    const path = js ? (attributes.src ?? attributes.href) : attributes.rel === 'stylesheet' ? attributes.href : undefined;
    if (!path) continue;
    const url = new URL(path, 'http://localhost/');
    assert.equal(url.origin, 'http://localhost', `Unexpected remote startup asset ${path}`);
    if (js) startup.add(decodeURIComponent(url.pathname.slice(1)));
    else stylesheets.add(decodeURIComponent(url.pathname.slice(1)));
  }
  assert.ok(startup.size > 0, 'Vite build must include a startup JS entry');
  const measure = async (assets) =>
    Promise.all(
      [...assets].map(async (asset) => {
        const bytes = gzipSync(await readFile(join(app, 'dist', asset))).length;
        return bytes;
      })
    );
  const jsGzip = (await measure(startup)).reduce((a, b) => a + b, 0);
  const cssGzip = (await measure(stylesheets)).reduce((a, b) => a + b, 0);
  assert.ok(jsGzip <= 300 * 1024, `Startup JS exceeds 300 KiB (${jsGzip} bytes gzip across ${startup.size} assets)`);
  console.log(`P1-9_BUNDLE PASS startup_js_gzip=${jsGzip} css_gzip=${cssGzip} limit=${300 * 1024}`);
}

async function trial(number, previewPort) {
  const temporary = await mkdtemp(join(tmpdir(), `nmh-p1-9-${number}-`));
  let gateway;
  let chrome;
  try {
    gateway = await startGateway(join(temporary, 'state.sqlite'));
    const token = gateway.token;
    const base = `http://127.0.0.1:${gateway.port}`;
    const rpc = createORPCClient(new RPCLink({ url: base, headers: () => ({ authorization: `Bearer ${token}` }) }));
    assert.ok(token, 'Gateway must emit desktop token');

    // Verify WebSocket subprotocol authentication per HELPER-BRIEF conventions
    const authedWs = new WebSocket(base.replace(/^http/, 'ws') + '/ws', ['bearer.' + token]);
    await new Promise((done, reject) => { authedWs.onopen = done; authedWs.onerror = reject; });
    authedWs.close();

    // 1. Enable sample-ts and verify initial route response
    assert.equal((await rpc.extensions.enable({ id: 'sample-ts' })).status, 'running');
    const initHello = await (await fetch(`${base}/x/sample-ts/hello`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.deepEqual(initHello, { message: 'Hello from TypeScript' });

    // 2. Open Settings page in browser
    const pageUrl = `http://127.0.0.1:${previewPort}/settings?gateway=${encodeURIComponent(base)}&token=${encodeURIComponent(token)}`;
    chrome = await startChrome(join(temporary, 'chrome'));
    const page = await pageSession(chrome, pageUrl);

    try {
      // 3. Verify Settings page elements
      await page.eventually('!!document.querySelector("[data-testid=settings-channels-open]")', 'Channels button');
      await page.eventually('!!document.querySelector("[data-testid=settings-models-open]")', 'Models button');
      await page.eventually('!!document.querySelector("[data-testid=settings-extension-sample-ts]")', 'sample-ts extension section');
      await page.eventually('!!document.querySelector("[data-testid=settings-form-sample-ts]")', 'sample-ts schema form');

      // Check initial values in form
      await page.eventually('document.querySelector("[data-testid=setting-input-sample-ts-greeting]")?.value === "Hello from TypeScript"', 'initial greeting');
      assert.equal(await page.evaluate('document.querySelector("[data-testid=setting-input-sample-ts-maxRetries]")?.value'), '3');
      assert.equal(await page.evaluate('document.querySelector("[data-testid=setting-secret-status-sample-ts-apiSecret]")?.textContent'), 'Not configured');

      // 4. Edit in UI: new greeting, new maxRetries, new apiSecret
      const newGreeting = `Greetings Neo UI trial ${number}`;
      const newRetries = 7;
      const secretValue = `super-vault-token-${number}-${Date.now()}`;

      const setInput = async (selector, val) => {
        await page.evaluate(`
          (() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            const lastValue = el.value;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(el, ${JSON.stringify(val)});
            const tracker = el._valueTracker;
            if (tracker) tracker.setValue(lastValue + '_diff');
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          })()
        `);
      };

      await setInput('[data-testid=setting-input-sample-ts-greeting]', newGreeting);
      await page.eventually(`document.querySelector("[data-testid=setting-input-sample-ts-greeting]")?.value === ${JSON.stringify(newGreeting)}`, 'greeting input set');

      await setInput('[data-testid=setting-input-sample-ts-maxRetries]', String(newRetries));
      await page.eventually(`document.querySelector("[data-testid=setting-input-sample-ts-maxRetries]")?.value === "${newRetries}"`, 'maxRetries input set');

      await setInput('[data-testid=setting-input-sample-ts-apiSecret]', secretValue);
      await page.eventually(`document.querySelector("[data-testid=setting-input-sample-ts-apiSecret]")?.value === ${JSON.stringify(secretValue)}`, 'apiSecret input set');

      await page.eventually('!(document.querySelector("[data-testid=settings-save-sample-ts]")?.disabled || document.querySelector("[data-testid=settings-save-sample-ts]")?.getAttribute("aria-disabled") === "true")', 'settings save button ready');

      // Click save button
      await page.evaluate('document.querySelector("[data-testid=settings-save-sample-ts]").click(); true');

      // Wait for save confirmation
      await page.eventually(
        'document.querySelector("[data-testid=settings-status-sample-ts]")?.textContent.includes("Saved")',
        'settings saved status message'
      );

      // Verify UI shows secret as Configured and clears write-only secret input
      await page.eventually(
        'document.querySelector("[data-testid=setting-secret-status-sample-ts-apiSecret]")?.textContent === "Configured"',
        'apiSecret status updated to Configured'
      );
      assert.equal(
        await page.evaluate('document.querySelector("[data-testid=setting-input-sample-ts-apiSecret]")?.value'),
        '',
        'Secret input must be cleared after save (write-only)'
      );

      // 5. sample-ts sees new values immediately!
      const updatedHello = await (await fetch(`${base}/x/sample-ts/hello`, { headers: { authorization: `Bearer ${token}` } })).json();
      assert.deepEqual(updatedHello, { message: newGreeting }, 'sample-ts hello route must return updated greeting');

      const updatedConfig = await (await fetch(`${base}/x/sample-ts/config`, { headers: { authorization: `Bearer ${token}` } })).json();
      assert.equal(updatedConfig.greeting, newGreeting);
      assert.equal(updatedConfig.maxRetries, newRetries);
      assert.equal(updatedConfig.hasSecret, true);
      assert.equal(updatedConfig.apiSecret, secretValue, 'sample-ts must receive decrypted secret from vault');

      // 6. Secret is NEVER returned via settings.get
      const settingsGetResult = await rpc.settings.get({ extension: 'sample-ts' });
      assert.equal(settingsGetResult.values.greeting, newGreeting);
      assert.equal(settingsGetResult.values.maxRetries, newRetries);
      assert.deepEqual(settingsGetResult.values.apiSecret, { set: true }, 'Secret field must return { set: true } only');
      assert.equal(settingsGetResult.values.apiSecret?.secret, undefined);
      assert.ok(!JSON.stringify(settingsGetResult).includes(secretValue), 'Plaintext secret must NEVER appear in settings.get payload');

      // 7. Viewer role cannot call settings.set (returns 403)
      const orgListRes = await fetch(`${base}/auth/organization/list`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const orgList = await orgListRes.json();
      const orgId = orgList[0]?.id ?? 'default';

      const apiKeyRes = await fetch(`${base}/auth/api-key/create`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: `Viewer Key ${number}`,
          expiresIn: 3600,
          metadata: {
            workspaceId: orgId,
            role: 'viewer',
          },
        }),
      });
      const apiKeyData = await apiKeyRes.json();
      const viewerApiKey = apiKeyData.key;
      assert.ok(viewerApiKey, 'Viewer API key created');

      const viewerClient = createORPCClient(new RPCLink({ url: base, headers: () => ({ 'x-api-key': viewerApiKey }) }));

      // Viewer can get settings
      const viewerGet = await viewerClient.settings.get({ extension: 'sample-ts' });
      assert.equal(viewerGet.values.greeting, newGreeting);
      assert.deepEqual(viewerGet.values.apiSecret, { set: true });

      // Viewer CANNOT set settings (403 Forbidden)
      await assert.rejects(
        viewerClient.settings.set({ extension: 'sample-ts', values: { greeting: 'Hacked by viewer' } }),
        (err) => err.code === 'FORBIDDEN',
        'Viewer must be rejected with FORBIDDEN when calling settings.set'
      );

      // 8. Disabling sample-ts removes its section from UI
      await rpc.extensions.disable({ id: 'sample-ts' });
      await page.eventually(
        '!document.querySelector("[data-testid=settings-extension-sample-ts]")',
        'sample-ts section removed from Settings page when disabled'
      );

      // Re-enabling sample-ts restores its section
      await rpc.extensions.enable({ id: 'sample-ts' });
      await page.eventually(
        '!!document.querySelector("[data-testid=settings-extension-sample-ts]")',
        'sample-ts section restored on Settings page when re-enabled'
      );

      console.log(`P1-9_BROWSER PASS trial=${number} extension=sample-ts secret_write_only=true viewer_forbidden=403 reactive_toggle=true`);
    } finally {
      await page.close();
    }
  } finally {
    chrome?.close();
    if (gateway) await gateway.close();
    await rm(temporary, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
  }
}

await verifyBuild();
const port = await freePort();
const preview = spawn(
  process.execPath,
  [join(app, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: app, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
);
let previewErrors = '';
preview.stderr.on('data', (buffer) => { previewErrors += buffer.toString(); });

try {
  await awaitHttp(`http://127.0.0.1:${port}/settings`, 'Vite preview');
  await trial(1, port);
  await trial(2, port);
  console.log('P1-9_EXIT PASS trials=2 typecheck=3 pwa=200');
} finally {
  preview.kill();
  if (previewErrors) console.log(`Preview stderr: ${previewErrors.slice(0, 300)}`);
}
