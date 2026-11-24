import assert from 'node:assert/strict';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { parse as parseYaml } from 'yaml';

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

async function fakeUpstreamFeed(directory) {
  const registry = parseYaml(await readFile(join(repo, 'upstream', 'registry.yaml'), 'utf8'));
  const { pins } = JSON.parse(await readFile(join(repo, 'upstream.lock.json'), 'utf8'));
  const feed = { github: {}, npm: {} };
  const entries = [
    ...Object.entries(registry.upstreams ?? {}),
    ...Object.entries(registry.adopted ?? {}).map(([name, value]) => [name, { ...value, channel: 'main' }]),
  ];
  const changed = entries.find(([name, value]) => pins[name]?.ref && value.channel === 'stable-release')
    ?? entries.find(([name]) => pins[name]?.ref);
  assert.ok(changed, 'Fixture must contain a pinned upstream');
  const target = changed[0];
  for (const [name, value] of entries) {
    const pinned = pins[name]?.ref;
    const latest = name === target ? 'v99.0.0-p6-3' : pinned;
    if (value.channel === 'npm-latest' && value.package) {
      feed.npm[value.package] = latest || '0.0.0';
    } else if (value.channel === 'stable-release') {
      feed.github[`repos/${value.upstream}/releases/latest`] = {
        tag_name: latest || 'v0.0.0',
        html_url: `https://example.test/changelog/${name}`,
      };
    } else {
      feed.github[`repos/${value.upstream}`] = { default_branch: 'main' };
      feed.github[`repos/${value.upstream}/commits?sha=main&per_page=1`] = [{
        sha: latest || '000000000000', commit: { committer: { date: '2026-11-18T00:00:00Z' } },
      }];
    }
  }
  const filename = join(directory, 'upstream-feed.json');
  await writeFile(filename, JSON.stringify(feed));
  return { filename, target, pinned: pins[target].ref };
}

let testAuthModule;

async function createMember(base, dbFile, role = 'member', existingOrganizationId) {
  const email = `p6-3-${role}@neo.local`;
  const password = 'P6-3-Test-Password!';
  // Desktop mode deliberately blocks public sign-up. Seed test identities through
  // the same Better Auth service against the gateway's isolated SQLite file.
  if (!testAuthModule) {
    const gatewayRequire = createRequire(join(gatewayDir, 'package.json'));
    const { register } = await import(pathToFileURL(gatewayRequire.resolve('tsx/esm/api')).href);
    register();
    testAuthModule = import(pathToFileURL(join(repo, 'packages/auth/src/index.ts')).href);
  }
  const { createNeoAuth } = await testAuthModule;
  const sqlite = new DatabaseSync(dbFile);
  let user;
  try {
    const secret = process.env.BETTER_AUTH_SECRET ?? process.env.NEO_AUTH_SECRET
      ?? (await readFile(join(dirname(dbFile), 'auth.secret'), 'utf8')).trim();
    const auth = createNeoAuth({ sqlite, secret, baseURL: base });
    ({ user } = await auth.api.signUpEmail({ body: { email, password, name: 'P6-3 Member' } }));
  } finally {
    sqlite.close();
  }
  let organizationId = existingOrganizationId;
  if (!organizationId) {
    const organization = await fetch(`${base}/auth/organization/create`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name: 'P6-3 Workspace', slug: 'p6-3-workspace' }),
    });
    if (!organization.ok) throw new Error(`Workspace create ${organization.status}: ${await organization.text()}`);
    organizationId = (await organization.json()).id;
  }
  const invite = await fetch(`${base}/auth/organization/invite-member`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ organizationId, email, role }),
  });
  if (!invite.ok) throw new Error(`Member invite ${invite.status}: ${await invite.text()}`);
  const { id: invitationId } = await invite.json();
  const login = await fetch(`${base}/auth/sign-in/email`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`Member login ${login.status}: ${await login.text()}`);
  const { token } = await login.json();
  assert.ok(token);
  const accept = await fetch(`${base}/auth/organization/accept-invitation`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ invitationId }),
  });
  if (!accept.ok) throw new Error(`Member accept ${accept.status}: ${await accept.text()}`);
  return { organizationId, rpc: createORPCClient(new RPCLink({ url: base,
    headers: { authorization: `Bearer ${token}` } })) };
}

let AUTH = '';
const authHeaders = () => ({ authorization: `Bearer ${AUTH}` });

async function startGateway(dbFile, hermesHome, modelUrl, dshUrl, upstreamFeed) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: gatewayDir,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    env: {
      ...process.env, NODE_ENV: 'test',
      NMH_SUPERAGENT_TEST_ADAPTER: new URL('../../../extensions/engine-superagent/test/scripted-models.ts', import.meta.url).href,
      NMH_UPSTREAM_CACHE: upstreamCache(),
      NMH_UPSTREAM_FEED: upstreamFeed,
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
  let failedOnce = false;
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
      let text = 'Hermes fake answer complete.';
      if (prompt.includes('P6-3 question') && !prompt.includes('Human answer:')) {
        text = JSON.stringify({ kind: 'question', summary: 'Need a project detail', question: 'Which project should Neo research?' });
      } else if (prompt.includes('P6-3 approval') && !prompt.includes('Approved by')) {
        text = JSON.stringify({ kind: 'approval', summary: 'Permission required', question: 'Allow destructive operation?', destructive: true });
      } else if (prompt.includes('P6-3 failure') && !failedOnce) {
        failedOnce = true;
        text = JSON.stringify({ kind: 'failure', summary: 'Temporary mocked execution error' });
      }
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
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.WebSocket = class extends WebSocket {
      constructor(...args) {
        super(...args);
        if (new URL(args[0]).pathname === '/ws') window.inboxTestSocket = this;
      }
    };
  ` }, sessionId);
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

async function trial(previewPort) {
  const temporary = await mkdtemp(join(tmpdir(), 'nmh-p6-3-'));
  const upstreamFeed = await fakeUpstreamFeed(temporary);
  const hermes = await fakeHermesModel();
  const dsh = await fakeDshModel();
  let gateway;
  let chrome;
  let page;
  try {
    const dbFile = join(temporary, 'state.sqlite');
    gateway = await startGateway(dbFile,
      join(temporary, 'hermes-home'), `http://127.0.0.1:${hermes.port}/v1`, `http://127.0.0.1:${dsh.port}`, upstreamFeed.filename);
    const base = `http://127.0.0.1:${gateway.port}`;
    const rpc = createORPCClient(new RPCLink({ url: base, headers: authHeaders }));
    assert.equal((await rpc.extensions.enable({ id: 'sample-ts' })).status, 'running');
    const registry = await rpc.extensions.enable({ id: 'skills-registry' });
    assert.equal(registry.status, 'running', registry.reason ?? gateway.errors());
    const engine = await rpc.extensions.enable({ id: 'engine-hermes' });
    assert.equal(engine.status, 'running', engine.reason ?? gateway.errors());
    const superagent = await rpc.extensions.enable({ id: 'engine-superagent' });
    assert.equal(superagent.status, 'running', superagent.reason ?? gateway.errors());
    const bot = await rpc.agents.bots.create({ name: 'P6-3 Scripted Bot' });

    const job = await rpc.inbox.cron.create({ botId: bot.id, text: 'Research a reusable Monday process',
      schedule: '0 0 1 1 *', mode: 'act' });
    assert.equal(job.requesterRole, 'owner');
    assert.ok((await rpc.inbox.cron.list()).some((entry) => entry.id === job.id));
    assert.deepEqual(await rpc.inbox.cron.fire({ id: job.id }), { ok: true });
    const cronReport = await eventually(async () => (await rpc.inbox.list())
      .find((item) => item.source === 'neo/cron' && item.text === job.text && item.status === 'ready'), 'cron report');
    assert.equal(cronReport.report.status, 'ready');
    assert.match(cronReport.report.summary, /Hermes fake answer complete/);
    assert.equal(cronReport.requesterRole, 'owner');
    assert.match(cronReport.report.postmortem.worked, /Delegation completed/i);
    assert.equal(cronReport.report.postmortem.reusable, true);
    assert.ok(cronReport.report.postmortem.skill);
    const skill = await rpc.x['skills-registry'].get({ name: cronReport.report.postmortem.skill });
    const provenance = `superagent:${cronReport.ticketId ?? cronReport.id}`;
    assert.equal(skill.metadata.provenance, provenance);
    assert.equal(skill.metadata.sourcePath, provenance);
    assert.equal(skill.metadata.autonomy, 'suggest');
    assert.equal(skill.metadata.trust, 'untrusted');
    assert.match(skill.content, /autonomy: suggest/);
    console.log('P6-3_SKILL PASS provenance=superagent:ticket autonomy=suggest trust=untrusted');

    const traces = await rpc.inbox.decisions.list({ ticketId: cronReport.id });
    for (const action of ['eval', 'accept', 'delegate', 'postmortem']) {
      assert.ok(traces.some((trace) => trace.chosenAction === action), `Missing ${action} decision`);
    }
    for (const trace of traces) {
      for (const field of ['trace_id', 'ticketId', 'source', 'inputsSummary', 'candidates',
        'chosenAction', 'modelRole', 'latencyMs', 'outcome', 'choice', 'ranking',
        'model_id', 'success', 'actual_latency_ms']) {
        assert.ok(Object.hasOwn(trace, field), `Trace missing ${field}`);
      }
      assert.equal(trace.source, 'neo/cron');
    }
    for (const action of ['eval', 'postmortem']) {
      const trace = traces.find((entry) => entry.chosenAction === action);
      assert.equal(trace.model_id, 'scripted');
      assert.equal(trace.choice.model_id, 'scripted');
      assert.deepEqual(trace.ranking, [{ model_id: 'scripted' }]);
    }
    for (const action of ['accept', 'delegate']) {
      assert.equal(traces.find((entry) => entry.chosenAction === action).model_id, `policy:${action}`);
    }
    const logFile = join(temporary, 'extensions', 'engine-superagent', 'traces', 'decisions.jsonl');
    const lines = (await readFile(logFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(lines.length >= traces.length);
    console.log('P6-3_TRACE PASS format=panda-jsonl eval=logged accept=logged delegate=logged');

    chrome = await startChrome(join(temporary, 'chrome'));
    page = await pageSession(chrome, `http://127.0.0.1:${previewPort}/inbox?gateway=${encodeURIComponent(base)}&token=${encodeURIComponent(AUTH)}`);
    await page.eventually('!!document.querySelector(".inbox-page")', 'lazy Inbox');
    await page.eventually('!![...document.querySelectorAll(".inbox-item")].find(row => row.querySelector(".inbox-request")?.textContent?.includes("reusable Monday") && row.querySelector("[data-testid=inbox-postmortem]")?.textContent?.includes("Reusable procedure suggested"))', 'rendered post-mortem card');
    console.log('P6-3_CARD PASS postmortem=visible lazy_inbox=true');

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
    console.log('P6-3_CHANNEL PASS source=neo/channel reply=delivered');

    await rpc.inbox.channel.emit({ id: 'viewer-1', channelId: 'telegram:test', senderId: 'viewer-1',
      botId: bot.id, memberRole: 'viewer', text: '@neo delete the customer database', mode: 'act' });
    const blocked = await eventually(async () => (await rpc.inbox.list())
      .find((item) => item.source === 'neo/channel' && item.requesterRole === 'viewer' && item.status === 'blocked'), 'viewer blocked');
    assert.equal(blocked.mode, 'act');
    assert.match(blocked.report.summary, /Viewer role can observe.*cannot act/i);
    assert.match((await rpc.inbox.channel.replies()).find((reply) => reply.inReplyTo === 'viewer-1').text, /Viewer role/);
    const observe = await rpc.inbox.ask({ botId: bot.id, text: 'Review a safe proposal', mode: 'observe' });
    assert.equal(observe.status, 'suggestion');
    console.log('P6-3_POLICY PASS viewer_act=blocked reason=visible owner_observe=suggestion');

    const upstream = await rpc.inbox.upstream.check();
    assert.ok(upstream.drift >= 1, 'Fake feed must produce drift');
    assert.ok(upstream.checked >= upstream.drift, 'All scanned engines are counted');
    const upstreamItems = (await rpc.inbox.list()).filter((item) => item.source === 'neo/upstream');
    assert.equal(upstreamItems.length, upstream.drift, 'One Inbox item per drifted engine');
    assert.equal(new Set(upstreamItems.map((item) => item.upstream.name)).size, upstreamItems.length);
    const target = upstreamItems.find((item) => item.upstream.name === upstreamFeed.target);
    assert.ok(target, `Missing drift for ${upstreamFeed.target}`);
    assert.equal(target.mode, 'observe');
    assert.equal(target.upstream.pinned, upstreamFeed.pinned);
    assert.equal(target.upstream.latest, 'v99.0.0-p6-3');
    assert.match(target.upstream.changelog, /^https:\/\//);
    assert.match(target.report.summary, /bump .* and run the suites/i);
    await assert.rejects(rpc.inbox.accept({ id: target.id }), 'Upstream act is disabled');
    await rpc.inbox.upstream.check();
    assert.equal((await rpc.inbox.list()).filter((item) => item.source === 'neo/upstream').length,
      upstreamItems.length, 'Repeated scans must reuse engine items');
    await page.eventually(`!![...document.querySelectorAll('.inbox-item')].find(row => row.querySelector('[data-testid=inbox-upstream]')?.textContent?.includes(${JSON.stringify(upstreamFeed.target)}) && row.querySelector('[data-testid=inbox-upstream]')?.textContent?.includes('Current pin:') && !row.querySelector('[data-action=accept]'))`, 'read-only upstream card');
    console.log('P6-3_UPSTREAM PASS fake_feed=true deduped=true pin_latest_changelog=true observe_only=true');

    const question = await rpc.inbox.ask({ botId: bot.id, mode: 'act', text: 'P6-3 question: research a chosen project' });
    const waiting = await eventually(async () => (await rpc.inbox.list())
      .find((item) => item.id === question.id && item.status === 'question'), 'question waiting', 120000);
    assert.equal(waiting.kind, 'question');
    await page.eventually(`!!document.querySelector('[data-testid="inbox-${question.id}"] [data-testid="inbox-question"] textarea')`, 'question input');
    await page.evaluate(`(() => { const row = document.querySelector('[data-testid="inbox-${question.id}"]'); window.inboxTestAnswer = row.querySelector('textarea'); window.inboxTestAnswer.focus(); return true })()`);
    await page.typeText('Project Orion');
    await page.eventually(`document.querySelector('[data-testid="inbox-${question.id}"] [data-action=reply]').getAttribute('aria-disabled') !== 'true'`, 'reply enabled');
    await page.evaluate(`(() => { window.inboxPreviousSocket = window.inboxTestSocket; window.inboxPreviousSocket.close(); return true })()`);
    await page.eventually(`window.inboxTestSocket !== window.inboxPreviousSocket && document.querySelector('.connection')?.textContent === 'Live'`, 'Inbox reconnected');
    await sleep(500);
    assert.equal(await page.evaluate(`(() => { const row = document.querySelector('[data-testid="inbox-${question.id}"]'); const answer = row.querySelector('textarea'); return answer === window.inboxTestAnswer && answer === document.activeElement && answer.value === 'Project Orion' && row.querySelector('[data-action=reply]').getAttribute('aria-disabled') !== 'true' })()`), true, 'Draft, focus, and reply state survive snapshot and event replay');
    console.log('P6-3_DRAFT PASS reconnect=true identity=true focus=true draft=true reply_enabled=true');
    await page.evaluate(`document.querySelector('[data-testid="inbox-${question.id}"] [data-action=reply]').click()`);
    const resumedQuestion = await eventually(async () => (await rpc.inbox.list())
      .find((item) => item.id === question.id && item.status === 'ready'), 'question resumed', 120000);
    assert.equal(resumedQuestion.report.status, 'ready');
    assert.ok(hermes.seen.some((prompt) => prompt.includes('Human answer: Project Orion')));
    console.log('P6-3_QUESTION PASS paused=true browser_reply=true resumed=true');

    const approvalAsk = await rpc.inbox.ask({ botId: bot.id, mode: 'act', text: 'P6-3 approval: change production state' });
    const approval = await eventually(async () => (await rpc.inbox.list())
      .find((item) => item.id === approvalAsk.id && item.status === 'approval'), 'approval waiting', 120000);
    assert.equal(approval.approval.destructive, true);
    await page.eventually(`!!document.querySelector('[data-testid="inbox-${approvalAsk.id}"] [data-testid="inbox-approval"] [data-action=approve]')`, 'approval card');
    const member = await createMember(base, dbFile);
    const admin = await createMember(base, dbFile, 'admin', member.organizationId);
    await assert.rejects(member.rpc.inbox.approval.decide({ id: approval.id, decision: 'approve', reason: 'Member request' }),
      (error) => error?.code === 'FORBIDDEN', 'Member must receive a 403 for destructive approval');
    assert.equal((await admin.rpc.inbox.approval.decide({ id: approval.id,
      decision: 'approve', reason: 'Admin approved after review' })).status, 'running');
    const approved = await eventually(async () => (await rpc.inbox.list())
      .find((item) => item.id === approval.id && item.status === 'ready'), 'admin approval resumed', 120000);
    assert.equal(approved.approval.decision, 'approved');
    assert.ok(hermes.seen.some((prompt) => prompt.includes('Approved by admin:')));
    console.log('P6-3_APPROVAL PASS destructive_member_403=true admin_resumes=true reason_recorded=true');

    const failedAsk = await rpc.inbox.ask({ botId: bot.id, mode: 'act', text: 'P6-3 failure: recover on retry' });
    const failed = await eventually(async () => (await rpc.inbox.list())
      .find((item) => item.id === failedAsk.id && item.status === 'failed'), 'failed ticket', 120000);
    assert.equal(failed.kind, 'failure');
    assert.match(failed.report.summary, /Temporary mocked execution error/);
    await page.eventually(`!!document.querySelector('[data-testid="inbox-${failedAsk.id}"] [data-action=retry]')`, 'failure retry button');
    await page.evaluate(`document.querySelector('[data-testid="inbox-${failedAsk.id}"] [data-action=retry]').click()`);
    const recovered = await eventually(async () => (await rpc.inbox.list())
      .find((item) => item.id === failed.id && item.status === 'ready'), 'failure recovered', 120000);
    assert.equal(recovered.report.status, 'ready');
    console.log('P6-3_FAILURE PASS error_visible=true browser_retry=true recovered=true');

    await rpc.inbox.cron.delete({ id: job.id });
    const beforeDisable = await readFile(logFile, 'utf8');
    assert.equal((await rpc.extensions.disable({ id: 'engine-superagent' })).status, 'disabled');
    await assert.rejects(rpc.inbox.cron.fire({ id: job.id }));
    await assert.rejects(rpc.inbox.channel.emit(channelMsg));
    await assert.rejects(rpc.inbox.ask({ botId: bot.id, text: 'After disable', mode: 'act' }));
    await sleep(250);
    assert.equal(await readFile(logFile, 'utf8'), beforeDisable, 'No new traces after disabling the extension');
    assert.equal((await fetch(base + '/x/sample-ts/hello', { headers: authHeaders() })).status, 200);
    assert.equal((await rpc.extensions.list()).find((entry) => entry.id === 'engine-hermes')?.status, 'running');
    console.log('P6-3_DISABLE PASS sources=stopped other_extensions=running');
  } finally {
    if (page) await page.close().catch(() => {});
    chrome?.close();
    hermes.release();
    if (gateway) await gateway.close();
    await Promise.all([new Promise((done) => hermes.server.close(done)), new Promise((done) => dsh.server.close(done))]);
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

try {
  nodeTool(app, 'vite/bin/vite.js', ['build']);
  const previewPort = await freePort();
  const preview = spawn(process.execPath, [join(app, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort'], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try {
    await awaitHttp(`http://127.0.0.1:${previewPort}/inbox`, 'Vite preview');
    await trial(previewPort);
  } finally {
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(preview.pid), '/T', '/F'], { windowsHide: true });
    else preview.kill();
  }
  console.log('P6-3 PASS authenticated=true build_first=true scripted_models=true fake_feed=true upstream_drift=true question_resume=true destructive_member_403=true admin_approval=true failure_retry=true disable_isolation=true');
} catch (error) {
  console.error('P6-3 FAIL', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
