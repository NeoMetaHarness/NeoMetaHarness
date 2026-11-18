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

async function createMember(base, role = 'member', existingOrganizationId) {
  const email = `p6-3-${role}@neo.local`;
  const password = 'P6-3-Test-Password!';
  const signup = await fetch(`${base}/auth/sign-up/email`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'P6-3 Member' }),
  });
  if (!signup.ok) throw new Error(`Member sign-up ${signup.status}: ${await signup.text()}`);
  const { user } = await signup.json();
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

// Fake GitHub REST API. No network call leaves the loopback interface.
// https://docs.github.com/en/rest/issues/comments
// https://docs.github.com/en/rest/pulls/comments
// https://docs.github.com/en/rest/checks/runs
async function fakeGitHub() {
  const state = { limited: false, comments: [{
    id: 7, body: '@neo summarise',
    issue_url: 'https://api.github.com/repos/test/project/issues/3',
    html_url: 'https://github.com/test/project/issues/3#issuecomment-7',
  }], posts: [], requests: [] };
  const server = createHttpServer(async (req, res) => {
    const buffers = [];
    for await (const buffer of req) buffers.push(buffer);
    state.requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    if (state.limited) {
      res.writeHead(429, { 'retry-after': '60' }).end(JSON.stringify({ message: 'rate limited' }));
      return;
    }
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
      result = { check_runs: [{ id: 44, name: 'CI', status: 'completed', conclusion: 'failure',
        html_url: 'https://github.com/test/project/actions/runs/44' }] };
    } else {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { state, server, url: `http://127.0.0.1:${address.port}` };
}

async function trial() {
  const temporary = await mkdtemp(join(tmpdir(), 'nmh-p6-4-'));
  const github = await fakeGitHub();
  const hermes = await fakeHermesModel();
  const dsh = await fakeDshModel();
  let gateway;
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
    const bot = await rpc.agents.bots.create({ name: 'P6-4 Fake GitHub Bot' });
    const token = 'fake-p6-4-vault-token';
    const repositories = [{ name: 'test/project', ref: 'main' }];
    stage = 'GitHub configure';
    await rpc.inbox.github.configure({ repositories, mode: 'observe', botId: bot.id, token });
    assert.equal((await rpc.inbox.github.status()).hasToken, true);
    assert.equal(JSON.stringify(await rpc.inbox.github.status()).includes(token), false);
    stage = 'GitHub initial poll';
    await rpc.inbox.github.poll();

    stage = 'GitHub observe report';
    const observed = await eventually(async () => (await rpc.inbox.list()).find((item) =>
      item.source === 'neo/github' && item.github?.kind === 'comment' && item.mode === 'observe'
      && item.status === 'ready'), 'observe report');
    assert.equal(observed.github.issue, 3);
    assert.match(observed.github.url, /github.com\/test\/project\/issues\/3/);
    assert.match(observed.report.summary, /summarise/);
    assert.equal(github.state.posts.length, 0);
    console.log('P6-4_OBSERVE PASS @neo=Inbox report link=true no_post=true');

    const failed = await eventually(async () => (await rpc.inbox.list()).find((item) =>
      item.source === 'neo/github' && item.github?.kind === 'check' && item.status === 'failed'
      && item.kind === 'failure'), 'failing check');
    assert.match(failed.report.summary, /CI.*failure/);
    console.log('P6-4_CHECK PASS failing_check=failure_item');

    stage = 'GitHub act approval';
    github.state.comments.push({ id: 8, body: '@neo research release notes',
      issue_url: 'https://api.github.com/repos/test/project/issues/3',
      html_url: 'https://github.com/test/project/issues/3#issuecomment-8' });
    await rpc.inbox.github.configure({ repositories, mode: 'act' });
    await rpc.inbox.github.poll();
    const pending = await eventually(async () => (await rpc.inbox.list()).find((item) =>
      item.source === 'neo/github' && item.text === 'research release notes'
      && item.status === 'approval' && item.report?.status === 'ready'), 'admin approval', 120000);
    assert.equal(github.state.posts.length, 0);
    const { rpc: member } = await createMember(base, 'member');
    await assert.rejects(member.inbox.approval.decide({ id: pending.id, decision: 'approve', reason: 'test' }),
      (error) => error.message.includes('403') || /FORBIDDEN|admin/i.test(error.message));
    assert.equal(github.state.posts.length, 0);
    await rpc.inbox.approval.decide({ id: pending.id, decision: 'approve', reason: 'Approved test reply' });
    const sent = await eventually(async () => (await rpc.inbox.list()).find((item) =>
      item.id === pending.id && item.status === 'ready' && item.github.posted), 'posted reply');
    assert.equal(github.state.posts.length, 1);
    assert.equal(github.state.posts[0].path, '/repos/test/project/issues/3/comments');
    assert.equal(github.state.posts[0].body, sent.report.summary);
    assert.ok(github.state.requests.every((request) => request.authorization === `Bearer ${token}`));
    console.log('P6-4_APPROVAL PASS act=admin-approved member=403 reply=fake-GitHub');

    stage = 'GitHub 429';
    github.state.limited = true;
    await assert.rejects(rpc.inbox.github.poll());
    const requestsOn429 = github.state.requests.length;
    await rpc.inbox.github.poll();
    assert.equal(github.state.requests.length, requestsOn429);
    assert.ok((await rpc.inbox.github.status()).pausedUntil > Date.now());
    console.log('P6-4_RATE_LIMIT PASS status=429 cooldown=true no_tight_loop=true');

    stage = 'GitHub disable isolation';
    github.state.limited = false;
    await rpc.inbox.github.configure({ repositories, mode: 'observe' });
    await rpc.inbox.github.poll();
    assert.equal((await rpc.extensions.disable({ id: 'engine-superagent' })).status, 'disabled');
    const requestsOnDisable = github.state.requests.length;
    await sleep(1100);
    assert.equal(github.state.requests.length, requestsOnDisable, 'GitHub polling must stop on disable');
    assert.equal((await fetch(base + '/x/sample-ts/hello', { headers: authHeaders() })).status, 200);
    assert.equal((await rpc.extensions.list()).find((entry) => entry.id === 'engine-hermes')?.status, 'running');
    console.log('P6-4_DISABLE PASS polling=stopped others=healthy');
  } catch (error) {
    console.error(`P6-4_STAGE ${stage} ${gateway?.errors().slice(0,650).replace(/\s+/g, ' ')}`);
    throw error;
  } finally {
    hermes.release();
    await gateway?.close();
    await Promise.all([new Promise((done) => github.server.close(done)),
      new Promise((done) => hermes.server.close(done)), new Promise((done) => dsh.server.close(done))]);
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

try {
  nodeTool(app, 'vite/bin/vite.js', ['build']);
  await trial();
  console.log('P6-4 PASS authenticated=true build_first=true scripted_models=true fake_GitHub=true observe_report=true admin_approval=true failing_check=true rate_limit=true disable_isolation=true');
} catch (error) {
  console.error('P6-4 FAIL', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}

