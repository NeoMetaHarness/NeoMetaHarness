import assert from 'node:assert/strict';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { fakeHoncho } from './fake-honcho.mjs';
import { requireUpstreamCache } from '../../../tests/upstream-cache.mjs';
requireUpstreamCache('apps/neo-app/test/p4-5.mjs', ['hermes-agent']);

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '../..');
const chromeBinary = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function eventually(check, name) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error('Timed out observing ' + name);
}

async function fakeModel() {
  const calls = [];
  const server = createHttpServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET' && req.url === '/v1/models') {
      return send(200, { object: 'list', data: [{ id: 'fake-model', object: 'model' }] });
    }
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) return send(404, {});
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push(input);
    if (!input.stream) {
      return send(200, {
        id: 'fake-honcho-turn', object: 'chat.completion', model: 'fake-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hermes fake answer complete.' }, finish_reason: 'stop' }],
      });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const push = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({
      id: 'fake-honcho-turn', object: 'chat.completion.chunk', created: 1,
      model: 'fake-model', choices: [{ index: 0, delta, finish_reason }],
    }) + '\n\n');
    push({ role: 'assistant', content: '' });
    push({ content: 'Hermes fake answer complete.' });
    push({}, 'stop');
    res.end('data: [DONE]\n\n');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    calls,
    url: 'http://127.0.0.1:' + server.address().port + '/v1',
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

async function gatewayFor(dbFile, hermesHome, modelUrl) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: join(repo, 'apps', 'gateway'),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    env: {
      ...process.env, NMH_DB_PATH: dbFile, NMH_HERMES_HOME: hermesHome,
      NMH_HERMES_MODEL_URL: modelUrl, NMH_EXTENSIONS_DIR: join(repo, 'extensions'),
      NMH_PORT: '0', NEO_MODE: 'desktop', NEO_PRINT_DESKTOP_TOKEN: '1',
    },
  });
  let token = '';
  let stderr = '';
  child.stderr.on('data', (bytes) => { stderr += bytes.toString(); });
  const port = await new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('Gateway startup timeout ' + stderr)), 20000);
    const lines = createInterface({ input: child.stdout });
    const success = (result) => { clearTimeout(timeout); lines.close(); done(result); };
    lines.on('line', (line) => {
      if (line.startsWith('NEO_DESKTOP_TOKEN ')) token = line.slice(18).trim();
      if (line.startsWith('GATEWAY_READY ')) success(JSON.parse(line.slice(14)).port);
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error('Gateway exited ' + code + ': ' + stderr)));
  });
  assert.ok(token.length > 0, 'Desktop authorization token missing');
  return {
    base: 'http://127.0.0.1:' + port, token,
    errors: () => stderr,
    async close() {
      if (child.exitCode !== null) return;
      const exited = new Promise((done) => child.once('exit', done));
      child.send('shutdown');
      await Promise.race([exited, sleep(10000).then(() => { throw new Error('Gateway shutdown timed out'); })]);
      assert.equal(child.exitCode, 0, 'Gateway shutdown failed: ' + stderr);
    },
  };
}

async function runHermes(rpc, base, token) {
  const started = await rpc.x['engine-hermes'].runs.start({
    profile: 'bota', input: 'Use memory for the papaya checksum protocol.',
  });
  const socket = new WebSocket(base.replace(/^http/, 'ws') + '/ws', ['bearer.' + token]);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  try {
    const { RPCLink: WsLink } = await import('@orpc/client/websocket');
    const events = createORPCClient(new WsLink({ websocket: socket }));
    let terminal;
    for await (const event of await events.x['engine-hermes'].runs.events({
      profile: 'bota', runId: started.run_id,
    })) {
      if (['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(event.type)) {
        terminal = event.type;
        break;
      }
    }
    assert.equal(terminal, 'run.completed', 'Hermes turn must finish while Honcho is unavailable');
  } finally {
    socket.close();
  }
}

async function previewFor() {
  const server = createHttpServer().listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  const child = spawn(process.execPath, [
    join(app, 'node_modules', 'vite', 'bin', 'vite.js'),
    'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort',
  ], { cwd: app, stdio: 'ignore', windowsHide: true });
  const url = 'http://127.0.0.1:' + port;
  await eventually(async () => {
    try { return (await fetch(url + '/memory')).ok; } catch { return false; }
  }, 'built Vite preview');
  return {
    url,
    close() {
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill();
    },
  };
}

async function memoryPageFor(profile, url) {
  const chrome = spawn(chromeBinary, [
    '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let port;
  await eventually(async () => {
    try {
      port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      return Number.isInteger(port) && port > 0;
    } catch { return false; }
  }, 'Chrome debugging endpoint');
  const version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((done, reject) => { ws.onopen = done; ws.onerror = reject; });
  const pending = new Map();
  let sequence = 0;
  ws.onmessage = ({ data }) => {
    const response = JSON.parse(data);
    if (response.id && pending.has(response.id)) {
      pending.get(response.id)(response);
      pending.delete(response.id);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((done, reject) => {
    const id = ++sequence;
    pending.set(id, (message) => message.error ? reject(new Error(message.error.message)) : done(message.result));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url }, sessionId);
  const evaluate = async (expression) => {
    const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (value.exceptionDetails) throw new Error('Browser exception ' + value.exceptionDetails.text);
    return value.result.value;
  };
  return {
    evaluate,
    async close() {
      await send('Target.closeTarget', { targetId }).catch(() => {});
      ws.close();
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(chrome.pid), '/T', '/F'], { windowsHide: true });
      else chrome.kill();
    },
  };
}

async function trial() {
  const temp = await mkdtemp(join(tmpdir(), 'nmh-p4-5-'));
  const honcho = await fakeHoncho();
  const model = await fakeModel();
  let gateway;
  let preview;
  let page;
  try {
    gateway = await gatewayFor(join(temp, 'state.sqlite'), join(temp, 'hermes-home'), model.url);
    const rpc = createORPCClient(new RPCLink({
      url: gateway.base,
      headers: () => ({ authorization: 'Bearer ' + gateway.token }),
    }));
    const scope = { kind: 'workspace', workspaceId: 'default' };
    await rpc.vault.put({ scope, name: 'HONCHO_URL', value: honcho.url });
    await rpc.vault.put({ scope, name: 'HONCHO_API_KEY', value: 'isolated-honcho-key' });
    for (const id of ['memory-local', 'memory-honcho', 'engine-hermes']) {
      const state = await rpc.extensions.enable({ id });
      assert.equal(state.status, 'running', id + ': ' + state.reason);
    }
    assert.equal(await rpc.x['memory-honcho'].status({ workspace: 'default' }), 'ok');
    await rpc.x['engine-hermes'].profiles.create({ name: 'bota' });
    await runHermes(rpc, gateway.base, gateway.token);
    await eventually(() => honcho.writes.length >= 2, 'non-blocking Honcho write-back');
    assert.deepEqual(honcho.writes.slice(0, 2).map((record) => record.peer_id), ['nmh_user', 'nmh_bot']);
    assert.equal(honcho.writes[0].metadata.source, 'honcho.turn');
    console.log('P4-5_STAGE authenticated Hermes turn wrote to the isolated Honcho HTTP API');

    const beforeNextTurn = model.calls.length;
    await runHermes(rpc, gateway.base, gateway.token);
    assert.ok(model.calls.slice(beforeNextTurn).some((call) => JSON.stringify(call).includes('honcho:')),
      'Next Hermes model request did not include the tagged Honcho context');
    console.log('P4-5_STAGE next Hermes model request includes honcho: L2 context');

    preview = await previewFor();
    page = await memoryPageFor(join(temp, 'chrome'),
      preview.url + '/memory?gateway=' + encodeURIComponent(gateway.base) + '&token=' + encodeURIComponent(gateway.token));
    await eventually(async () => await page.evaluate(
      'document.querySelector("[data-testid=honcho-status]")?.textContent === "Honcho ok"'),
    'Honcho ok badge');
    await page.evaluate('document.querySelector("[data-testid=memory-source-filter] button, button[data-testid=memory-source-filter]").click()');
    await eventually(async () => await page.evaluate('[...document.querySelectorAll("[role=option]")].some(el => el.textContent.trim() === "Honcho")'), 'Honcho source filter option');
    await page.evaluate('[...document.querySelectorAll("[role=option]")].find(el => el.textContent.trim() === "All").click()');
    await eventually(async () => await page.evaluate(
      'document.querySelector("[data-testid=memory-list]")?.textContent.includes("Hermes fake answer complete.")'),
    'Honcho memory rows');
    console.log('P4-5_STAGE Honcho source filter and ok badge rendered on the built Memory page');

    honcho.outage(true);
    const beforeOutage = model.calls.length;
    await runHermes(rpc, gateway.base, gateway.token);
    assert.ok(model.calls.length > beforeOutage, 'Hermes turn stopped during Honcho outage');
    assert.equal(await rpc.x['memory-honcho'].status({ workspace: 'default' }), 'degraded');
    await eventually(async () => await page.evaluate(
      'document.querySelector("[data-testid=honcho-status]")?.textContent === "Honcho degraded"'),
    'Honcho degraded badge');
    console.log('P4-5_STAGE Honcho HTTP 503 kept Hermes alive and showed degraded badge');

    await rpc.extensions.disable({ id: 'memory-honcho' });
    assert.equal(await rpc.x['memory-honcho'].status({ workspace: 'default' }), 'off');
    await eventually(async () => await page.evaluate(
      'document.querySelector("[data-testid=honcho-status]")?.textContent === "Honcho off"'),
    'Honcho off badge');
    const beforeDisable = model.calls.length;
    await runHermes(rpc, gateway.base, gateway.token);
    assert.ok(model.calls.length > beforeDisable, 'Hermes unavailable after disabling Honcho');
    assert.ok((await rpc.x['memory-local'].list({ workspace: 'default' }))
      .some((record) => record.source === 'hermes.turn'), 'L1 write-back unavailable after disabling Honcho');
    console.log('P4-5_BROWSER PASS honcho-writeback=true next-turn-honcho-context=true outage-fallback=true badge-degraded=true disable-l1=true');
  } catch (error) {
    console.error('P4-5_FAILURE', error, 'GATEWAY STDERR', gateway?.errors());
    throw error;
  } finally {
    if (page) await page.close();
    preview?.close();
    if (gateway) await gateway.close();
    await model.close();
    await honcho.close();
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

// Build first, then launch the preview and exercise authenticated live paths.
execFileSync(process.execPath, [join(app, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
  cwd: app, stdio: 'pipe',
});
await trial();
console.log('P4-5_EXIT PASS verified authenticated L2 write, next-turn injection, outage fallback and disable isolation');
