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
    body: JSON.stringify({ name: 'P6-6 member-scoped test key', expiresIn: 3600,
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

// Fake GitHub REST API (loopback only). Comments and check runs are mutable per phase.
// https://docs.github.com/en/rest/issues/comments
// https://docs.github.com/en/rest/pulls/comments
// https://docs.github.com/en/rest/checks/runs
async function fakeGitHub() {
  const state = { comments: [], checks: [], posts: [], requests: [] };
  const server = createHttpServer(async (req, res) => {
    const buffers = [];
    for await (const buffer of req) buffers.push(buffer);
    state.requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    let result;
    if (req.method === 'POST') {
      const posted = JSON.parse(Buffer.concat(buffers).toString('utf8'));
      state.posts.push({ path: req.url, body: posted.body });
      result = { id: 100 + state.posts.length };
    } else if (req.url.includes('/issues/comments?')) {
      result = state.comments;
    } else if (req.url.includes('/pulls/comments?')) {
      result = [];
    } else if (req.url.includes('/check-runs?')) {
      result = { check_runs: state.checks };
    } else {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let nextId = 1;
  return {
    state, server, url: `http://127.0.0.1:${address.port}`,
    comment(body, issue = 3) {
      const id = nextId++;
      state.comments.push({ id, body, issue_url: `https://api.github.com/repos/test/project/issues/${issue}`,
        html_url: `https://github.com/test/project/issues/${issue}#issuecomment-${id}` });
    },
    failCheck(name) {
      const id = 40 + nextId++;
      state.checks.push({ id, name, status: 'completed', conclusion: 'failure',
        html_url: `https://github.com/test/project/actions/runs/${id}` });
    },
  };
}

const forbidden = (error) => error?.code === 'FORBIDDEN' || /403|FORBIDDEN/.test(String(error?.message));

async function trial(previewPort) {
  const temporary = await mkdtemp(join(tmpdir(), 'nmh-p6-6-'));
  const github = await fakeGitHub();
  const hermes = await fakeHermesModel();
  const dsh = await fakeDshModel();
  let gateway;
  let chrome;
  let page;
  let stage = 'gateway startup';
  try {
    gateway = await startGateway(join(temporary, 'state.sqlite'), join(temporary, 'hermes'),
      `http://127.0.0.1:${hermes.port}/v1`, `http://127.0.0.1:${dsh.port}`,
      join(temporary, 'fake-upstream-feed.json'), github.url);
    const base = `http://127.0.0.1:${gateway.port}`;
    const rpc = createORPCClient(new RPCLink({ url: base, headers: authHeaders }));
    stage = 'enable extensions';
    assert.equal((await rpc.extensions.enable({ id: 'sample-ts' })).status, 'running');
    assert.equal((await rpc.extensions.enable({ id: 'engine-hermes' })).status, 'running');
    const started = await rpc.extensions.enable({ id: 'engine-superagent' });
    assert.equal(started.status, 'running', started.reason ?? gateway.errors());
    const bot = await rpc.agents.bots.create({ name: 'P6-6 Scripted Bot' });
    const { rpc: member } = await createMember(base);
    const list = () => rpc.inbox.list();
    const find = (predicate, label, timeout) => eventually(async () => (await list()).find(predicate), label, timeout);
    const delegated = (text) => hermes.seen.some((prompt) => prompt.includes(text));

    stage = 'accept mode policy';
    assert.deepEqual(await rpc.inbox.acceptMode.get(), { mode: 'observe' }, 'observe is the default');
    assert.deepEqual(await member.inbox.acceptMode.get(), { mode: 'observe' });
    await assert.rejects(member.inbox.acceptMode.set({ mode: 'act' }), forbidden, 'member must not change the accept mode');
    assert.deepEqual(await rpc.inbox.acceptMode.get(), { mode: 'observe' });
    console.log('P6-6_MODE PASS default=observe member_get=200 member_set=403');

    stage = 'observe suggestions';
    const token = 'fake-p6-6-vault-token';
    const repositories = [{ name: 'test/project', ref: 'main' }];
    github.comment('@neo summarise the release thread');
    github.failCheck('CI');
    await rpc.inbox.github.configure({ repositories, botId: bot.id, token });
    assert.equal(JSON.stringify(await rpc.inbox.github.status()).includes(token), false);
    await rpc.inbox.github.poll();
    const commentSuggestion = await find((item) => item.source === 'neo/github' && item.github?.kind === 'comment'
      && item.text === 'summarise the release thread' && item.status === 'suggestion', 'comment suggestion');
    assert.equal(commentSuggestion.kind, 'suggestion');
    assert.equal(commentSuggestion.acceptMode, 'observe');
    assert.equal(commentSuggestion.destructive, false);
    assert.equal(commentSuggestion.github.issue, 3);
    const checkFailure = await find((item) => item.github?.kind === 'check' && item.kind === 'failure'
      && item.status === 'failed', 'failing check record');
    assert.match(checkFailure.report.summary, /CI.*failure/);
    const checkSuggestion = await find((item) => item.github?.kind === 'check' && item.status === 'suggestion'
      && item.kind === 'suggestion', 'failing check suggestion');
    assert.match(checkSuggestion.text, /^Investigate failing check "CI" in test\/project/);
    await sleep(800);
    assert.equal(delegated('summarise the release thread'), false, 'observe must not start work');
    assert.equal(delegated('Investigate failing check'), false, 'observe must not start work');
    assert.equal(github.state.posts.length, 0);
    console.log('P6-6_OBSERVE PASS comment=suggestion failing_check=failure+suggestion no_work=true no_post=true');

    stage = 'Inbox UI';
    chrome = await startChrome(join(temporary, 'chrome'));
    page = await pageSession(chrome, `http://127.0.0.1:${previewPort}/inbox?gateway=${encodeURIComponent(base)}&token=${encodeURIComponent(AUTH)}`);
    await page.eventually('document.querySelector("select[aria-label=\'Accept mode\']")?.value === "observe"', 'accept mode selector');
    const row = (id) => `document.querySelector('[data-testid="inbox-${id}"]')`;
    await page.eventually(`!!${row(commentSuggestion.id)}?.querySelector('[data-testid=inbox-suggestion] [data-action=accept]') && !!${row(commentSuggestion.id)}?.querySelector('[data-action=dismiss]')`, 'comment Suggestion card');
    await page.eventually(`!!${row(checkSuggestion.id)}?.querySelector('[data-action=dismiss]')`, 'check Suggestion card');

    stage = 'dismiss from the Inbox';
    await page.evaluate(`${row(checkSuggestion.id)}.querySelector('[data-action=dismiss]').click()`);
    await find((item) => item.id === checkSuggestion.id && item.status === 'dismissed', 'dismissed suggestion');
    await page.eventually(`${row(checkSuggestion.id)}?.dataset.status === 'dismissed' && !${row(checkSuggestion.id)}.querySelector('[data-action=dismiss]')`, 'dismissed card');
    const dismissTrace = (await rpc.inbox.decisions.list({ ticketId: checkSuggestion.id }))
      .find((trace) => trace.chosenAction === 'dismiss');
    assert.equal(dismissTrace?.outcome, 'dismissed');
    await rpc.inbox.github.poll();
    await sleep(600);
    assert.equal((await list()).filter((item) => item.text === checkSuggestion.text).length, 1, 'a dismissed check is not raised again');
    assert.equal(delegated('Investigate failing check'), false);
    await assert.rejects(rpc.inbox.accept({ id: checkSuggestion.id }), 'a dismissed Suggestion cannot be accepted');
    console.log('P6-6_DISMISS PASS ui_dismiss=true trace=dismiss no_rerun=true no_work=true');

    stage = 'member accepts a Suggestion';
    const accepted = await member.inbox.accept({ id: commentSuggestion.id });
    assert.equal(accepted.mode, 'act');
    const acceptedReport = await find((item) => item.id === commentSuggestion.id && item.status === 'approval'
      && item.report?.status === 'ready', 'accepted work report', 120000);
    assert.ok(delegated('summarise the release thread'), 'accepting starts the work');
    assert.equal(github.state.posts.length, 0, 'observe never posts without an admin');
    await assert.rejects(member.inbox.approval.decide({ id: acceptedReport.id, decision: 'approve', reason: 'member' }), forbidden);
    await rpc.inbox.approval.decide({ id: acceptedReport.id, decision: 'approve', reason: 'Approved P6-6 reply' });
    await find((item) => item.id === acceptedReport.id && item.status === 'ready' && item.github.posted, 'posted reply');
    assert.equal(github.state.posts.length, 1);
    assert.equal(github.state.posts[0].path, '/repos/test/project/issues/3/comments');
    console.log('P6-6_ACCEPT PASS member_accept=200 work_started=true reply=admin_approved');

    stage = 'destructive Suggestion needs admin';
    await rpc.inbox.acceptMode.set({ mode: 'act' });
    github.comment('@neo delete the stale release branches');
    await rpc.inbox.github.poll();
    const destructive = await find((item) => item.text === 'delete the stale release branches' && item.status === 'suggestion',
      'destructive suggestion');
    assert.equal(destructive.destructive, true);
    assert.equal(destructive.acceptMode, 'act');
    await sleep(800);
    assert.equal(delegated('delete the stale release branches'), false, 'destructive work never starts on its own, even in act');
    await page.eventually(`${row(destructive.id)}?.querySelector('[data-testid=inbox-suggestion]')?.textContent?.includes('Destructive: an admin must accept')`, 'destructive notice');
    await assert.rejects(member.inbox.accept({ id: destructive.id }), forbidden, 'member must get 403 accepting destructive work');
    assert.equal((await list()).find((item) => item.id === destructive.id)?.status, 'suggestion');
    await page.evaluate(`${row(destructive.id)}.querySelector('[data-action=accept]').click()`);
    const destructiveDone = await find((item) => item.id === destructive.id && item.status === 'approval'
      && item.report?.status === 'ready', 'admin-accepted destructive work', 120000);
    assert.ok(delegated('delete the stale release branches'));
    assert.equal(destructiveDone.approval.destructive, true);
    assert.equal(github.state.posts.length, 1, 'destructive work never replies on its own');
    console.log('P6-6_DESTRUCTIVE PASS act_mode=suggestion member_accept=403 admin_ui_accept=runs reply=held');

    stage = 'act-with-approval';
    await rpc.inbox.acceptMode.set({ mode: 'act-with-approval' });
    assert.equal((await rpc.inbox.github.status()).mode, 'act-with-approval');
    github.comment('@neo research release notes');
    github.failCheck('Lint');
    await rpc.inbox.github.poll();
    const gated = await find((item) => item.text === 'research release notes' && item.status === 'approval'
      && item.report?.status === 'ready', 'act-with-approval report', 120000);
    assert.equal(gated.acceptMode, 'act-with-approval');
    assert.equal(github.state.posts.length, 1, 'act-with-approval holds the reply');
    const investigated = await find((item) => /^Investigate failing check "Lint"/.test(item.text)
      && item.status === 'ready', 'failing check investigated', 120000);
    assert.equal(investigated.mode, 'act');
    await rpc.inbox.approval.decide({ id: gated.id, decision: 'approve', reason: 'Approved' });
    await find((item) => item.id === gated.id && item.github.posted, 'approved reply');
    assert.equal(github.state.posts.length, 2);
    console.log('P6-6_ACT_WITH_APPROVAL PASS comment=ran+held check=investigated reply=after_approval');

    stage = 'act';
    await rpc.inbox.acceptMode.set({ mode: 'act' });
    github.comment('@neo draft the changelog', 5);
    await rpc.inbox.github.poll();
    const acted = await find((item) => item.text === 'draft the changelog' && item.status === 'ready'
      && item.github?.posted, 'act reply', 120000);
    assert.equal(acted.acceptMode, 'act');
    assert.equal(github.state.posts.length, 3);
    assert.equal(github.state.posts[2].path, '/repos/test/project/issues/5/comments');
    assert.equal(github.state.posts[2].body, acted.report.summary);
    assert.ok(github.state.requests.every((request) => request.authorization === `Bearer ${token}`), 'same vault token');
    console.log('P6-6_ACT PASS comment=ran reply=posted_without_approval vault_token=true');

    stage = 'legacy alias';
    await rpc.inbox.github.configure({ repositories, mode: 'observe' });
    assert.deepEqual(await rpc.inbox.acceptMode.get(), { mode: 'observe' });
    await rpc.inbox.github.configure({ repositories, mode: 'act' });
    assert.deepEqual(await rpc.inbox.acceptMode.get(), { mode: 'act-with-approval' });
    console.log('P6-6_LEGACY PASS github.configure.mode=alias observe->observe act->act-with-approval');

    stage = 'disable isolation';
    await page.close();
    page = undefined;
    assert.equal((await rpc.extensions.disable({ id: 'engine-superagent' })).status, 'disabled');
    await assert.rejects(rpc.inbox.acceptMode.get());
    await assert.rejects(rpc.inbox.dismiss({ id: destructive.id }));
    const requestsOnDisable = github.state.requests.length;
    await sleep(1100);
    assert.equal(github.state.requests.length, requestsOnDisable, 'GitHub polling stops on disable');
    assert.equal((await fetch(base + '/x/sample-ts/hello', { headers: authHeaders() })).status, 200);
    assert.equal((await rpc.extensions.list()).find((entry) => entry.id === 'engine-hermes')?.status, 'running');
    assert.equal((await rpc.extensions.enable({ id: 'engine-superagent' })).status, 'running');
    assert.deepEqual(await rpc.inbox.acceptMode.get(), { mode: 'act-with-approval' }, 'accept mode persists');
    assert.equal((await rpc.inbox.list()).find((item) => item.id === checkSuggestion.id)?.status, 'dismissed', 'dismissal persists');
    console.log('P6-6_DISABLE PASS routes=unavailable polling=stopped others=healthy mode_persisted=true');
  } catch (error) {
    console.error(`P6-6_STAGE ${stage} ${gateway?.errors().slice(0, 650).replace(/\s+/g, ' ')}`);
    throw error;
  } finally {
    if (page) await page.close().catch(() => {});
    chrome?.close();
    hermes.release();
    await gateway?.close();
    await Promise.all([new Promise((done) => github.server.close(done)),
      new Promise((done) => hermes.server.close(done)), new Promise((done) => dsh.server.close(done))]);
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
  console.log('P6-6 PASS proves: authenticated desktop-token + member key; scripted models; fake GitHub only; workspace accept mode observe(default)|act-with-approval|act set by admin only; @neo comments and failing checks become Suggestions in observe, run with an admin-approved reply in act-with-approval, run and reply in act; Suggestions accepted (member, policy-checked) or dismissed (Inbox UI, engine ignore + trace); destructive work stays a Suggestion in every mode and only an admin can accept it; same vault token; disable isolation and persistence');
} catch (error) {
  console.error('P6-6 FAIL', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
