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
import { requireUpstreamCache } from '../../../tests/upstream-cache.mjs';
requireUpstreamCache('apps/neo-app/test/p4-2.mjs', ['hermes-agent']);

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
  let token;
  const port = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gateway startup timed out: ${errors}`)), 20000);
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
  nodeTool(join(repo, 'extensions', 'memory-local'), 'typescript/bin/tsc', ['--noEmit']);
  nodeTool(join(repo, 'extensions', 'engine-hermes'), 'typescript/bin/tsc', ['--noEmit']);
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
  const calls = [];
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
      calls.push(input);
      const messages = input.messages ?? [];
      const user = [...messages].reverse().find((item) => item.role === 'user');
      const text = String(user?.content ?? '');
      const toolDone = messages.some((item) => item.role === 'tool');
      const approval = text.includes('trigger_approval') && !toolDone;
      const slow = text.includes('trigger_stop') && !toolDone;
      const learning = text.includes('[/learn]') && !toolDone;
      const tool = {
        id: 'call_approval', type: 'function',
        function: { name: 'terminal', arguments: JSON.stringify({ command: 'rm -rf /tmp/danger_zone' }) },
      };
      const learnedSkill = `---\nname: neo-learned-workflow\ndescription: Reuse a verified fake agent workflow\n---\n\n# Neo workflow\n\n1. Check the inputs.\n2. Verify the output.\n`;
      const learnTool = {
        id: 'call_skill_manage', type: 'function',
        function: { name: 'skill_manage', arguments: JSON.stringify({
          operations: [{ action: 'create', name: 'neo-learned-workflow',
            category: 'workflows', content: learnedSkill }],
        }) },
      };
      const requestedTool = learning ? learnTool : approval ? tool : undefined;
      const message = requestedTool
        ? { role: 'assistant', content: learning ? 'Saving a learned skill.' : 'Requesting permission', tool_calls: [requestedTool] }
        : { role: 'assistant', content: toolDone ? 'Skill or approval action finished.' : 'Hermes fake answer complete.' };
      if (!input.stream) {
        if (slow) await sleep(20000);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'fake-completion', object: 'chat.completion', model: 'fake-model',
          choices: [{ index: 0, message, finish_reason: requestedTool ? 'tool_calls' : 'stop' }],
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
      } else if (requestedTool) {
        send({ content: learning ? 'Learning ' : 'Hello ' });
        send({ content: learning ? 'workflow.' : 'from Hermes.' });
        send({ tool_calls: [{ index: 0, ...requestedTool }] });
      } else {
        for (const piece of ['Permission ', 'declined. ', 'Run complete.']) send({ content: piece });
      }
      send({}, requestedTool ? 'tool_calls' : 'stop');
      if (!res.destroyed) res.end('data: [DONE]\n\n');
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, port: address.port, calls };
}

async function trial(previewPort) {
  const temporary = await mkdtemp(join(tmpdir(), 'nmh-p4-2-'));
  const model = await fakeModel();
  let gateway;
  let chrome;
  try {
    gateway = await startGateway(join(temporary, 'state.sqlite'),
      join(temporary, 'hermes-home'), 'http://127.0.0.1:' + model.port + '/v1');
    const base = 'http://127.0.0.1:' + gateway.port;
    const token = gateway.token;
    const rpc = createORPCClient(new RPCLink({ url: base, headers: { authorization: `Bearer ${token}` } }));
    assert.equal((await rpc.extensions.enable({ id: 'sample-ts' })).status, 'running');
    assert.equal((await rpc.extensions.enable({ id: 'memory-local' })).status, 'running');
    const hermes = await rpc.extensions.enable({ id: 'engine-hermes' });
    assert.equal(hermes.status, 'running', hermes.reason);

    chrome = await startChrome(join(temporary, 'chrome'));
    const url = 'http://127.0.0.1:' + previewPort + '/memory?gateway=' + encodeURIComponent(base) + '&token=' + encodeURIComponent(token);
    const page = await pageSession(chrome, url);
    try {
      await page.eventually('!!document.querySelector("[data-testid=memory-page]")', 'Memory lazy route');
      await page.evaluate(`(() => {
        const input = document.querySelector('[data-testid=memory-text]');
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(input, 'The papaya protocol keeps project context in local Neo memory.');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await page.eventually('!(document.querySelector("[data-testid=memory-save]")?.disabled || document.querySelector("[data-testid=memory-save]")?.getAttribute("aria-disabled") === "true")', 'memory add enabled');
      await page.evaluate('document.querySelector("[data-testid=memory-save]").click()');
      await page.eventually('document.querySelector("[data-testid=memory-list]")?.textContent?.includes("papaya protocol")', 'UI stored memory');
      const entries = await rpc.x['memory-local'].list({ workspace: 'default' });
      assert.ok(entries.some((item) => item.source === 'manual' && item.trust === 'confirmed'));
      console.log('P4-2_STAGE memory added in browser and persisted');

      const run = await rpc.x['engine-hermes'].runs.start({ profile: 'default',
        input: 'Explain the papaya protocol for the next project review.' });
      const runWs = new WebSocket(base.replace(/^http/, 'ws') + '/ws', ['bearer.' + token]);
      await new Promise((done, reject) => { runWs.onopen = done; runWs.onerror = reject; });
      const { RPCLink: WsLink } = await import('@orpc/client/websocket');
      const stream = createORPCClient(new WsLink({ websocket: runWs }));
      const events = [];
      for await (const event of await stream.x['engine-hermes'].runs.events({ profile: 'default', runId: run.run_id })) {
        events.push(event);
        if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) break;
      }
      runWs.close();
      assert.ok(events.some((event) => event.type === 'run.completed'), JSON.stringify(events.slice(-8)));
      const firstCall = model.calls.map(JSON.stringify).join('\n');
      assert.ok(firstCall.includes('<memory-context>'), 'Real Hermes prompt did not include memory context');
      assert.ok(firstCall.includes('papaya protocol'), 'Real Hermes prompt omitted stored memory text');
      let persisted = [];
      for (let retry = 0; retry < 40; retry++) {
        persisted = await rpc.x['memory-local'].list({ workspace: 'default' });
        if (persisted.some((entry) => entry.source === 'hermes.turn')) break;
        await sleep(250);
      }
      assert.ok(persisted.some((entry) => entry.source === 'hermes.turn'), 'Hermes sync_turn did not write back to Neo DB');
      await page.eventually('document.querySelector("[data-testid=memory-list]")?.textContent?.includes("hermes.turn")', 'Hermes writeback in Memory UI');
      assert.ok((await page.evaluate('document.querySelector("[data-testid=memory-list]").textContent')).includes('profile=default'),
        'Hermes provenance should be visible');
      console.log('P4-2_STAGE real Hermes request contains memory context, writeback visible in browser');

      const matched = await rpc.x['memory-local'].list({ workspace: 'default', query: 'papaya' });
      assert.ok(matched.some((item) => item.text.includes('papaya protocol')), 'Memory FTS/LIKE search failed');
      const other = await rpc.x['memory-local'].add({ workspace: 'default', subject: 'bot',
        subjectId: 'private', text: 'Private profile memory', source: 'manual',
        provenance: 'UI regression', trust: 'untrusted' });
      const scoped = await rpc.x['memory-local'].list({ workspace: 'default', subjectId: 'default' });
      assert.ok(!scoped.some((item) => item.id === other.id), 'Another profile memory leaked');
      await page.eventually('document.querySelector("[data-testid=memory-list]")?.textContent?.includes("Private profile memory")', 'editable memory visible');
      await page.evaluate(`[...document.querySelectorAll('[data-testid=memory-entry]')]
        .find((entry) => entry.textContent.includes('Private profile memory'))
        .querySelector('button').click()`);
      await page.eventually('document.querySelector("[data-testid=memory-text]")?.value === "Private profile memory"', 'edit loaded');
      await page.evaluate(`(() => {
        const input = document.querySelector('[data-testid=memory-text]');
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(input, 'Edited private profile memory');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await page.evaluate('document.querySelector("[data-testid=memory-save]").click()');
      await page.eventually('document.querySelector("[data-testid=memory-list]")?.textContent?.includes("Edited private profile memory")', 'memory edit saved');
      const exported = await rpc.x['memory-local'].export({ workspace: 'default' });
      assert.ok(exported['SOUL.md'].includes('Edited private profile memory'));
      assert.ok(exported['MEMORY.md'].includes('Edited private profile memory'));
      assert.ok(!exported['USER.md'].includes('Edited private profile memory'));
      await page.evaluate(`[...document.querySelectorAll('[data-testid=memory-entry]')]
        .find((entry) => entry.textContent.includes('Edited private profile memory'))
        .querySelectorAll('button')[1].click()`);
      await page.eventually('!document.querySelector("[data-testid=memory-list]")?.textContent?.includes("Edited private profile memory")', 'memory delete persisted');
      assert.ok(!(await rpc.x['memory-local'].list({ workspace: 'default' })).some((item) => item.id === other.id));
      console.log('P4-2_STORE PASS fts_search=true profile_scope=true ui_edit=true ui_delete=true markdown_export=true');

      await rpc.extensions.disable({ id: 'memory-local' });
      assert.equal((await fetch(base + '/x/memory-local/list', { headers: { authorization: `Bearer ${token}` } })).status, 404);
      const before = model.calls.length;
      const fallback = await rpc.x['engine-hermes'].runs.start({ profile: 'default', input: 'Continue with the next step.' });
      const wsNext = new WebSocket(base.replace(/^http/, 'ws') + '/ws', ['bearer.' + token]);
      await new Promise((done, reject) => { wsNext.onopen = done; wsNext.onerror = reject; });
      const nextStream = createORPCClient(new WsLink({ websocket: wsNext }));
      const last = [];
      for await (const event of await nextStream.x['engine-hermes'].runs.events({ profile: 'default', runId: fallback.run_id })) {
        last.push(event);
        if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) break;
      }
      wsNext.close();
      assert.ok(last.some((event) => event.type === 'run.completed'), JSON.stringify(last.slice(-8)));
      assert.ok(!model.calls.slice(before).map(JSON.stringify).join('\n').includes('papaya protocol'),
        'Disabled memory provider should not prefetch remembered context');
      assert.equal((await fetch(base + '/x/sample-ts/hello', { headers: { authorization: `Bearer ${token}` } })).status, 200);
      console.log('P4-2_BROWSER PASS ui_add=true memory_context=true writeback=true disabled_404=true hermes_healthy=true sample_healthy=true');
    } catch (error) {
      console.error('P4-2_BROWSER FAILURE', error, 'GATEWAY ERRORS', gateway?.errors());
      throw error;
    } finally { await page.close(); }
  } finally {
    chrome?.close();
    if (gateway) await gateway.close();
    model.server.closeAllConnections();
    await new Promise((done) => model.server.close(done));
    try { await rm(temporary, { recursive: true, force: true, maxRetries: 15, retryDelay: 500 }); } catch (rmErr) { console.error("RM cleanup error (ignored):", rmErr.message); }
  }
}
await verifyBuild();
const port = await freePort();
const preview = spawn(process.execPath, [join(app, 'node_modules', 'vite', 'bin', 'vite.js'),
  'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: app, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
try {
  await awaitHttp(`http://127.0.0.1:${port}/skills`, 'Vite preview');
  await trial(port);
  console.log('P4-2_EXIT PASS');
} finally {
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(preview.pid), '/T', '/F'], { windowsHide: true });
  else preview.kill();
}
