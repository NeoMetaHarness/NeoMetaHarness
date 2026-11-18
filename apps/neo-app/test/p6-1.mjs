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


async function eventually(check, label, timeout = 90000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) { lastError = error; }
    await sleep(200);
  }
  throw new Error(`${label} timed out${lastError ? ': ' + lastError.message : ''}`);
}

async function trial() {
  const temporary = await mkdtemp(join(tmpdir(), 'nmh-p6-1-'));
  const hermes = await fakeHermesModel();
  const dsh = await fakeDshModel();
  let gateway;
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
    const bot = await rpc.agents.bots.create({ name: 'P6-1 Scripted Bot' });

    const job = await rpc.inbox.cron.create({ botId: bot.id, text: 'Research the Monday topic',
      schedule: '0 0 1 1 *', mode: 'act' });
    assert.equal(job.requesterRole, 'owner');
    assert.ok((await rpc.inbox.cron.list()).some((entry) => entry.id === job.id));
    assert.deepEqual(await rpc.inbox.cron.fire({ id: job.id }), { ok: true });
    const cronReport = await eventually(async () => (await rpc.inbox.list())
      .find((item) => item.source === 'neo/cron' && item.text === job.text && item.status === 'ready'), 'cron report');
    assert.equal(cronReport.report.status, 'ready');
    assert.match(cronReport.report.summary, /Hermes fake answer complete/);
    assert.equal(cronReport.requesterRole, 'owner');
    console.log('P6-1_CRON PASS source=neo/cron inbox=ready report=ready');

    const channelMsg = { id: 'channel-1', channelId: 'telegram:test', senderId: 'member-1',
      botId: bot.id, memberRole: 'member', text: '@neo do channel research', mode: 'act' };
    assert.deepEqual(await rpc.inbox.channel.emit(channelMsg), { ok: true });
    const channelReport = await eventually(async () => (await rpc.inbox.list())
      .find((item) => item.source === 'neo/channel' && item.text === 'do channel research' && item.status === 'ready'), 'channel report');
    assert.equal(channelReport.requesterRole, 'member');
    const channelReply = await eventually(async () => (await rpc.inbox.channel.replies())
      .find((reply) => reply.inReplyTo === channelMsg.id), 'channel reply');
    assert.equal(channelReply.channelId, channelMsg.channelId);
    assert.match(channelReply.text, /Hermes fake answer complete/);
    console.log('P6-1_CHANNEL PASS source=neo/channel reply=delivered');

    await rpc.inbox.channel.emit({ id: 'viewer-1', channelId: 'telegram:test', senderId: 'viewer-1',
      botId: bot.id, memberRole: 'viewer', text: '@neo delete the customer database', mode: 'act' });
    const blocked = await eventually(async () => (await rpc.inbox.list())
      .find((item) => item.source === 'neo/channel' && item.requesterRole === 'viewer' && item.status === 'blocked'), 'viewer blocked');
    assert.equal(blocked.mode, 'act');
    assert.match(blocked.report.summary, /Viewer role can observe.*cannot act/i);
    assert.match((await rpc.inbox.channel.replies()).find((reply) => reply.inReplyTo === 'viewer-1').text, /Viewer role/);
    const observe = await rpc.inbox.ask({ botId: bot.id, text: 'Review a safe proposal', mode: 'observe' });
    assert.equal(observe.status, 'suggestion');
    console.log('P6-1_POLICY PASS viewer_act=blocked reason=visible owner_observe=suggestion');

    await rpc.inbox.cron.delete({ id: job.id });
    assert.equal((await rpc.extensions.disable({ id: 'engine-superagent' })).status, 'disabled');
    await assert.rejects(rpc.inbox.cron.fire({ id: job.id }));
    await assert.rejects(rpc.inbox.channel.emit(channelMsg));
    assert.equal((await fetch(base + '/x/sample-ts/hello', { headers: authHeaders() })).status, 200);
    assert.equal((await rpc.extensions.list()).find((entry) => entry.id === 'engine-hermes')?.status, 'running');
    console.log('P6-1_DISABLE PASS sources=stopped other_extensions=running');
  } finally {
    hermes.release();
    if (gateway) await gateway.close();
    await Promise.all([new Promise((done) => hermes.server.close(done)), new Promise((done) => dsh.server.close(done))]);
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

try {
  nodeTool(app, 'vite/bin/vite.js', ['build']);
  await trial();
  console.log('P6-1 PASS authenticated=true scripted=true build_first=true');
} catch (error) {
  console.error('P6-1 FAIL', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
