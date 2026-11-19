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

async function createMember(base) {
  // Desktop sign-up is closed by P7-2. An owner's API key can restrict its
  // effective role to member, exercising the same gateway approval policy.
  const sessionResponse = await fetch(`${base}/auth/get-session`, { headers: authHeaders() });
  assert.equal(sessionResponse.status, 200);
  const { session } = await sessionResponse.json();
  const workspaceId = session?.activeOrganizationId;
  assert.ok(workspaceId, 'Desktop owner must have an active workspace');
  const keyResponse = await fetch(`${base}/auth/api-key/create`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ name: 'P6-8 member-scoped test key', expiresIn: 3600,
      metadata: { workspaceId, role: 'member' } }),
  });
  assert.equal(keyResponse.status, 200, 'Member-scoped test key creation must succeed');
  const { key } = await keyResponse.json();
  assert.ok(key);
  return { rpc: createORPCClient(new RPCLink({ url: base,
    headers: { 'x-api-key': key } })) };
}

let AUTH = '';
const authHeaders = () => ({ authorization: `Bearer ${AUTH}` });

async function startGateway(dbFile, hermesHome, modelUrl, dshUrl, upstreamFeed, githubUrl) {
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
      NMH_SUPERAGENT_GITHUB_API_URL: githubUrl, NMH_SUPERAGENT_GITHUB_POLL_INTERVAL_MS: '400',
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

const forbidden = (error) => error?.code === 'FORBIDDEN' || /403|FORBIDDEN/.test(String(error?.message));

// Scripted `neo upstream` scenario, read by extensions/engine-superagent/test/scripted-upstream.ts on every run.
function upstreamScenario(directory) {
  const file = join(directory, 'upstream-scenario.json');
  const drift = new Map();
  const write = (extra = {}) => writeFile(file, JSON.stringify({ checked: 6, drift: [...drift.values()], ...extra }));
  return {
    file,
    async set(name, pinned, latest) {
      drift.set(name, { name, upstream: `example/${name}`, pinned, latest, status: 'bump available',
        changelog: `https://github.com/example/${name}/releases/tag/${latest}` });
      await write();
    },
    fail: (message) => write({ error: message }),
    restore: () => write(),
    async calls() { try { return Number(await readFile(`${file}.calls`, 'utf8')); } catch { return 0; } },
  };
}

async function trial(previewPort) {
  const temporary = await mkdtemp(join(tmpdir(), 'nmh-p6-8-'));
  const scenario = upstreamScenario(temporary);
  const hermes = await fakeHermesModel();
  const dsh = await fakeDshModel();
  const lockfile = join(repo, 'upstream.lock.json');
  const lockBefore = await readFile(lockfile, 'utf8');
  let gateway;
  let chrome;
  let page;
  let stage = 'gateway startup';
  try {
    await scenario.set('hermes-agent', 'v0.23.2', 'v0.24.0');
    // The real checker is never used: its feed points at a missing file, and the fake counts its own runs.
    process.env.NMH_SUPERAGENT_TEST_UPSTREAM = new URL('../../../extensions/engine-superagent/test/scripted-upstream.ts', import.meta.url).href;
    process.env.NMH_SUPERAGENT_UPSTREAM_SCRIPT = scenario.file;
    gateway = await startGateway(join(temporary, 'state.sqlite'), join(temporary, 'hermes'),
      `http://127.0.0.1:${hermes.port}/v1`, `http://127.0.0.1:${dsh.port}`,
      join(temporary, 'missing-real-feed.json'), 'http://127.0.0.1:9');
    const base = `http://127.0.0.1:${gateway.port}`;
    const rpc = createORPCClient(new RPCLink({ url: base, headers: authHeaders }));
    stage = 'enable extensions';
    assert.equal((await rpc.extensions.enable({ id: 'sample-ts' })).status, 'running');
    assert.equal((await rpc.extensions.enable({ id: 'engine-hermes' })).status, 'running');
    const started = await rpc.extensions.enable({ id: 'engine-superagent' });
    assert.equal(started.status, 'running', started.reason ?? gateway.errors());
    const bot = await rpc.agents.bots.create({ name: 'P6-8 Upstream Bot' });
    const { rpc: member } = await createMember(base);
    const list = () => rpc.inbox.list();
    const find = (predicate, label, timeout) => eventually(async () => (await list()).find(predicate), label, timeout);
    const delegated = (text) => hermes.seen.some((prompt) => prompt.includes(text));
    const bumps = async (name) => (await list()).filter((item) => item.source === 'neo/upstream'
      && item.upstream?.name === name && !item.text.startsWith('Review upstream '));
    const reviews = async (name) => (await list()).filter((item) => item.source === 'neo/upstream'
      && item.upstream?.name === name && item.text.startsWith('Review upstream '));

    stage = 'routine';
    const job = (await rpc.inbox.cron.list()).find((entry) => entry.text === '@neo/upstream check');
    assert.ok(job, 'the neo upstream routine is a Neo cron job');
    assert.equal(job.schedule, '0 9 * * 1');
    assert.equal(job.botId, 'neo-system');
    assert.deepEqual(await rpc.inbox.cron.fire({ id: job.id }), { ok: true });
    assert.equal(await scenario.calls(), 1, 'the routine ran the injected checker');
    const hermesBump = await find((item) => item.source === 'neo/upstream' && item.upstream?.name === 'hermes-agent'
      && item.status === 'suggestion', 'hermes-agent bump suggestion');
    assert.equal(hermesBump.kind, 'suggestion');
    assert.equal(hermesBump.destructive, true);
    assert.equal(hermesBump.acceptMode, 'observe');
    assert.equal(hermesBump.botId, 'neo-system');
    assert.deepEqual([hermesBump.upstream.pinned, hermesBump.upstream.latest], ['v0.23.2', 'v0.24.0']);
    assert.match(hermesBump.report.summary, /admin must approve/);
    const status = await member.inbox.upstream.status();
    assert.equal(status.lastDrift, 1);
    assert.ok(status.lastCheckedAt > 0);
    assert.equal(status.botId, null);
    await sleep(600);
    assert.equal(delegated('hermes-agent'), false, 'the routine never starts work on its own');
    console.log('P6-8_ROUTINE PASS cron=weekly injected_checker=true drift=bump_suggestion admin_only=true no_work=true');

    stage = 'policy without a bot';
    await assert.rejects(member.inbox.upstream.configure({ botId: bot.id }), forbidden);
    await assert.rejects(member.inbox.upstream.check(), forbidden);
    // The extension refuses (the gateway does not forward extension error text); the owner is not a policy 403.
    await assert.rejects(rpc.inbox.accept({ id: hermesBump.id }), (error) => !forbidden(error));
    assert.equal((await list()).find((item) => item.id === hermesBump.id)?.status, 'suggestion');
    chrome = await startChrome(join(temporary, 'chrome'));
    page = await pageSession(chrome, `http://127.0.0.1:${previewPort}/inbox?gateway=${encodeURIComponent(base)}&token=${encodeURIComponent(AUTH)}`);
    const row = (id) => `document.querySelector('[data-testid="inbox-${id}"]')`;
    await page.eventually(`${row(hermesBump.id)}?.textContent?.includes('Configure a bot for upstream work') && !${row(hermesBump.id)}.querySelector('[data-action=accept]') && !!${row(hermesBump.id)}.querySelector('[data-action=dismiss]')`, 'bump card without a bot');
    console.log('P6-8_POLICY PASS member_configure=403 member_check=403 no_bot=refused ui_no_approve=true');

    stage = 'configure bot';
    assert.deepEqual(await rpc.inbox.upstream.configure({ botId: bot.id }), { ok: true });
    assert.equal((await rpc.inbox.upstream.status()).botId, bot.id);
    await find((item) => item.id === hermesBump.id && item.botId === bot.id, 'bump assigned to the bot');
    await rpc.inbox.upstream.check();
    assert.equal((await bumps('hermes-agent')).length, 1, 're-runs update the same Suggestion');
    await assert.rejects(member.inbox.accept({ id: hermesBump.id }), forbidden, 'member must get 403 approving a bump');
    assert.equal((await list()).find((item) => item.id === hermesBump.id)?.status, 'suggestion');
    assert.equal(delegated('Bump hermes-agent'), false);

    stage = 'admin approves from the Inbox';
    await page.eventually(`${row(hermesBump.id)}?.querySelector('[data-action=accept]')?.textContent === 'Approve bump'`, 'Approve bump button');
    await page.evaluate(`${row(hermesBump.id)}.querySelector('[data-action=accept]').click()`);
    const bumped = await find((item) => item.id === hermesBump.id && item.status === 'ready', 'bump ticket report', 120000);
    assert.equal(bumped.botId, bot.id);
    assert.equal(bumped.requesterRole, 'owner');
    assert.match(bumped.text, /^Bump hermes-agent from v0\.23\.2 to v0\.24\.0 in upstream\.lock\.json/);
    assert.ok(delegated('Bump hermes-agent from v0.23.2 to v0.24.0'), 'the approved bump is delegated to the bot');
    const traces = await rpc.inbox.decisions.list({ ticketId: hermesBump.id });
    for (const action of ['eval', 'accept', 'delegate']) assert.ok(traces.some((trace) => trace.chosenAction === action), action);
    await rpc.inbox.upstream.check();
    assert.equal((await bumps('hermes-agent')).length, 1, 'an approved bump is not proposed again for the same version');
    assert.equal(await readFile(lockfile, 'utf8'), lockBefore, 'Neo never edits upstream.lock.json');
    console.log('P6-8_APPROVE PASS member=403 admin_ui_approve=bot_ticket traces=eval,accept,delegate no_repeat=true lockfile_unchanged=true');

    stage = 'act modes add a read-only review';
    await rpc.inbox.acceptMode.set({ mode: 'act-with-approval' });
    await scenario.set('dsh-superagent', '8c32a9dc5d72', '9a1b2c3d4e5f');
    await rpc.inbox.upstream.check();
    const dshBump = (await bumps('dsh-superagent'))[0];
    assert.equal(dshBump?.status, 'suggestion', 'the bump itself still waits for approval');
    assert.equal(dshBump.acceptMode, 'act-with-approval');
    const dshReview = await find((item) => item.source === 'neo/upstream' && item.upstream?.name === 'dsh-superagent'
      && item.text.startsWith('Review upstream ') && item.status === 'ready', 'dsh-superagent review report', 120000);
    assert.match(dshReview.text, /Read-only: do not edit files or apply the upgrade/);
    assert.ok(delegated('Review upstream dsh-superagent'));
    assert.equal(delegated('Bump dsh-superagent'), false, 'the bump is not delegated without approval');
    await rpc.inbox.upstream.check();
    assert.equal((await reviews('dsh-superagent')).length, 1, 'one review per upstream version');
    await rpc.inbox.acceptMode.set({ mode: 'act' });
    await scenario.set('t3code', 'v0.1.9', 'v0.2.0');
    await rpc.inbox.upstream.check();
    await find((item) => item.upstream?.name === 't3code' && item.text.startsWith('Review upstream ')
      && item.status === 'ready', 't3code review in act', 120000);
    const t3Bump = (await bumps('t3code'))[0];
    assert.equal(t3Bump?.status, 'suggestion', 'act still never applies a bump');
    assert.equal(delegated('Bump t3code'), false);
    console.log('P6-8_ACT PASS act-with-approval=review+suggestion act=review+suggestion bump_needs_approval=true one_review_per_version=true');

    stage = 'dismiss';
    assert.equal((await member.inbox.dismiss({ id: dshBump.id })).status, 'dismissed');
    await rpc.inbox.upstream.check();
    assert.deepEqual((await bumps('dsh-superagent')).map((item) => item.status), ['dismissed'], 'a dismissed version stays dismissed');
    await rpc.inbox.acceptMode.set({ mode: 'observe' });
    await scenario.set('dsh-superagent', '8c32a9dc5d72', 'aaaabbbbcccc');
    await rpc.inbox.upstream.check();
    const moved = (await bumps('dsh-superagent')).filter((item) => item.status === 'suggestion');
    assert.equal(moved.length, 1, 'a new upstream version is proposed again');
    assert.equal(moved[0].upstream.latest, 'aaaabbbbcccc');
    assert.equal((await reviews('dsh-superagent')).length, 1, 'observe adds no review');
    console.log('P6-8_DISMISS PASS member_dismiss=true same_version=quiet new_version=raised observe=no_review');

    stage = 'restart';
    await page.close();
    page = undefined;
    assert.equal((await rpc.extensions.disable({ id: 'engine-superagent' })).status, 'disabled');
    assert.equal((await rpc.extensions.enable({ id: 'engine-superagent' })).status, 'running');
    assert.equal((await list()).find((item) => item.id === t3Bump.id)?.status, 'suggestion', 'pending bump survives a restart');
    assert.equal((await rpc.inbox.upstream.status()).botId, bot.id, 'routine settings persist');
    await rpc.inbox.upstream.check();
    assert.equal((await bumps('t3code')).length, 1, 'no duplicate after restart');
    assert.equal((await bumps('dsh-superagent')).length, 2, 'dismissal history kept after restart');
    await rpc.inbox.accept({ id: t3Bump.id });
    await find((item) => item.id === t3Bump.id && item.status === 'ready', 't3code bump after restart', 120000);
    assert.ok(delegated('Bump t3code from v0.1.9 to v0.2.0'));
    console.log('P6-8_RESTART PASS suggestion_survives=true settings_persist=true no_duplicate=true approve_after_restart=true');

    stage = 'checker error';
    await scenario.fail('gh api unavailable');
    const before = (await list()).length;
    await assert.rejects(rpc.inbox.upstream.check());
    assert.equal((await rpc.inbox.upstream.status()).lastError, 'gh api unavailable');
    assert.equal((await list()).length, before);
    await scenario.restore();
    await rpc.inbox.upstream.check();
    assert.equal((await rpc.inbox.upstream.status()).lastError, null);
    console.log('P6-8_ERROR PASS failure=reported_in_status inbox_unchanged=true recovers=true');

    stage = 'disable isolation';
    const callsBefore = await scenario.calls();
    assert.equal((await rpc.extensions.disable({ id: 'engine-superagent' })).status, 'disabled');
    await assert.rejects(rpc.inbox.upstream.check());
    await assert.rejects(rpc.inbox.upstream.status());
    assert.equal(await scenario.calls(), callsBefore, 'no routine runs while disabled');
    assert.equal((await fetch(base + '/x/sample-ts/hello', { headers: authHeaders() })).status, 200);
    assert.equal((await rpc.extensions.list()).find((entry) => entry.id === 'engine-hermes')?.status, 'running');
    assert.equal(await readFile(lockfile, 'utf8'), lockBefore, 'Neo never edits upstream.lock.json');
    console.log(`P6-8_DISABLE PASS routes=unavailable checker_calls=${callsBefore} (all scripted) others=healthy lockfile_unchanged=true`);
  } catch (error) {
    console.error(`P6-8_STAGE ${stage} ${gateway?.errors().slice(0, 650).replace(/\s+/g, ' ')}`);
    throw error;
  } finally {
    if (page) await page.close().catch(() => {});
    chrome?.close();
    hermes.release();
    await gateway?.close();
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
  console.log('P6-8 PASS proves: authenticated desktop-token + member key; scripted models; injected scripted upstream checker only (no network, no gh/npm); the weekly neo upstream cron routine turns drift into one admin-only bump Suggestion per engine; nothing runs in observe; act-with-approval/act add one read-only review per version but never apply a bump; an admin approval (Inbox UI) delegates the bump to the configured bot, member gets 403, no bot refuses; dismissals and approvals are not re-raised for the same version; pending bumps and settings survive a restart; checker errors surface in status; disable isolation; upstream.lock.json never changes');
} catch (error) {
  console.error('P6-8 FAIL', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
