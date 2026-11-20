import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { startCodingFixture } from './p6-9-coding.mjs';
import { gatewayReady } from './gateway-ready.mjs';
import assert from 'node:assert/strict';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, mkdir, copyFile } from 'node:fs/promises';
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

async function startGateway(dbFile, hermesHome, modelUrl, dshUrl, extra = {}) {
  const startedAt = Date.now();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: gatewayDir,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    detached: process.platform !== 'win32',
    env: {
      ...process.env, NODE_ENV: 'test',
      NMH_UPSTREAM_CACHE: upstreamCache(),
      NMH_DB_PATH: dbFile, NMH_HERMES_HOME: hermesHome, NMH_HERMES_MODEL_URL: modelUrl,
      NMH_SUPERAGENT_MODEL_URL: dshUrl, NMH_EXTENSIONS_DIR: join(repo, 'extensions'), NMH_PORT: '0', NEO_MODE: 'desktop', NEO_PRINT_DESKTOP_TOKEN: '1', ...extra,
    },
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
  const port = await gatewayReady(child, { onToken: token => { AUTH = token; }, errors: () => errors });
  console.log(`P6-9_GATEWAY_READY startup_ms=${Date.now() - startedAt}`);
  return { port, child, errors: () => errors, async close() {
    if (child.exitCode !== null) return;
    const exit = new Promise((done) => child.once('exit', done));
    child.send('shutdown');
    let timer;
    try {
      await Promise.race([exit, new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (child.exitCode === null) {
            if (process.platform === 'win32') spawnSync(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            else child.kill('SIGKILL');
          }
          reject(new Error(`Gateway shutdown timeout: ${errors}`));
        }, 45000);
      })]);
    } finally { clearTimeout(timer); }
    assert.equal(child.exitCode, 0, `Gateway shutdown error: ${errors}`);
  } };
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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(id, (message) => { clearTimeout(timer); message.error ? reject(new Error(`${method}: ${message.error.message}`)) : done(message.result); });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return { child, socket, send, close() {
    socket.close();
    if (process.platform === 'win32') spawnSync(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
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
    for (let retry = 0; retry < 1200; retry++) {
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


function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
async function scriptedModels() {
  const seen = [];
  const server = createHttpServer(async (req, res) => {
    try {
      if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: ['fake-model', 'p69-worker', 'p69-eval'].map(id => ({ id, object: 'model' })) })); return; }
      if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) { res.writeHead(404).end(); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString()); seen.push(input);
      const prompt = JSON.stringify(input.messages ?? []);
      const userMessages = (input.messages ?? []).filter(m => m.role === 'user');
      const task = userMessages.map(m => { try { return JSON.parse(m.content); } catch { return null; } }).find(m => m?.botId);
      const text = task?.text ?? String(userMessages.at(-1)?.content ?? '');
      const results = (input.messages ?? []).filter(m => m.role === 'tool');
      const tools = input.tools?.map(t => t.function.name) ?? [];
      let answer = { role: 'assistant', content: 'Scripted turn complete.' };
      const call = (pattern, args) => {
        const name = tools.find(t => pattern.test(t)); assert.ok(name, `Missing scripted tool ${pattern}: ${tools.join(',')}`);
        answer = { role: 'assistant', content: '', tool_calls: [{ id: `p69-tool-${results.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
      };
      if (input.model === 'p69-eval') {
        answer.content = JSON.stringify(prompt.includes('postmortem') ? { worked: 'Completed with tool evidence', failed: '', reusable: false } : { decision: 'accept' });
      } else if (tools.some(name => name.startsWith('mcp__neo__'))) {
        if (/Build X/.test(text)) {
          if (!results.length) call(/coding_projects_/, {});
          else if (results.length === 1) {
            const projects = JSON.parse(results[0].content).projects; assert.equal(projects.length, 1);
            call(/coding_build_/, { projectId: projects[0].id, text: 'Build X by creating feature.mjs.', title: 'Build feature X',
              branch: 'neo/p69-feature', files: ['feature.mjs'], description: 'Build X with isolated DSH. Local checks use scripted providers.' });
          } else if (results.length === 2) {
            const prepared = JSON.parse(results[1].content);
            call(/coding_pull_request_/, { repo: 'test/project', branch: prepared.branch, commit: prepared.commit });
          }
        } else if (!results.length && /Remember Z/.test(text)) call(/memory_remember_/, { text: 'p69-zebra-rendezvous is cobalt orchard.' });
        else if (!results.length) call(/agents_send_to_bot_/, { botId: task.botId, text: task.text });
      } else if (tools.includes('write') && prompt.includes('Build X')) {
        if (!results.length) call(/^write$/, { file_path: 'feature.mjs', content: 'console.log("P69_FEATURE_OK");\n' });
        else answer.content = 'DSH wrote and checked feature.mjs.';
      } else if (tools.includes('tool_call') && /Research Y/.test(text) && !results.length) {
        call(/^tool_call$/, { calls: [{ name: 'mcp__neo_computers__screenshot', arguments: {} }] });
      } else if (prompt.includes('p69-zebra-rendezvous')) {
        answer.content = prompt.includes('cobalt orchard') ? 'Recalled p69-zebra-rendezvous: cobalt orchard.' : 'No remembered rendezvous is available.';
      } else answer.content = 'Monday research report: the bot inspected its computer through MCP.';
      const finish = answer.tool_calls ? 'tool_calls' : 'stop';
      if (!input.stream) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'p69', object: 'chat.completion', model: input.model,
        choices: [{ index: 0, message: answer, finish_reason: finish }] })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'p69', object: 'chat.completion.chunk', created: 1,
        model: input.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
      emit({ role: 'assistant', content: answer.content ?? '' });
      if (answer.tool_calls) emit({ tool_calls: answer.tool_calls.map((t, index) => ({ index, ...t })) });
      emit({}, finish); res.end('data: [DONE]\n\n');
    } catch (error) { res.writeHead(500).end(String(error)); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}/v1` };
}
async function fakeGitHub(root) {
  const requests = []; const confirmations = [];
  const server = createHttpServer((req, res) => {
    try {
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
      assert.equal(req.method, 'GET', 'Exit scenarios must never publish through GitHub');
      assert.equal(req.headers.authorization, 'Bearer fake-p69-github-only');
      let result = [];
      if (req.url.includes('/check-runs')) result = { check_runs: [] };
      if (req.url.includes('/pulls?')) {
        const tree = git(root, ['worktree', 'list', '--porcelain']).split('\n\n').find(block => block.includes('branch refs/heads/neo/p69-feature'));
        if (tree) {
          const path = tree.split('\n').find(line => line.startsWith('worktree ')).slice(9);
          if (git(path, ['log', '-1', '--pretty=%s']) === 'Build feature X') {
            const sha = git(path, ['rev-parse', 'HEAD']); confirmations.push(sha);
            result = [{ number: 7, state: 'open', html_url: 'https://github.com/test/project/pull/7',
              head: { ref: 'neo/p69-feature', sha, repo: { full_name: 'test/project' } } }];
          }
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) { res.writeHead(500).end(String(error)); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { server, requests, confirmations, url: `http://127.0.0.1:${server.address().port}` };
}
async function prepareWhatsApp(temp) {
  const dir = join(temp, 'fake-whatsapp-bridge'); await mkdir(join(dir, 'node_modules'), { recursive: true });
  const original = join(repo, 'extensions/channels/test/fixtures/whatsapp-bridge');
  for (const file of ['bridge.mjs', 'package.json']) await copyFile(join(original, file), join(dir, file));
  const hash = createHash('sha256').update(await readFile(join(dir, 'package.json'))).digest('hex').slice(0, 16);
  await writeFile(join(dir, 'node_modules/.hermes-pkg-hash'), hash);
  return join(dir, 'bridge.mjs');
}
async function trial(previewPort) {
  const temporary = await mkdtemp(join(tmpdir(), 'nmh-p6-9-'));
  const models = await scriptedModels();
  let coding, github, gateway, chrome, page;
  try {
    coding = await startCodingFixture(temporary); github = await fakeGitHub(coding.root);
    const bridgeScript = await prepareWhatsApp(temporary);
    const home = join(temporary, 'hermes-home');
    const extra = { ...coding.env, NMH_SUPERAGENT_GITHUB_API_URL: github.url, NMH_SUPERAGENT_GITHUB_POLL_INTERVAL_MS: '120000',
      NMH_CHANNELS_WHATSAPP_BRIDGE_SCRIPT: bridgeScript, NMH_HERMES_RUNTIME_DIR: process.env.NMH_HERMES_RUNTIME_DIR ?? join(tmpdir(), 'nmh-hermes-runtime') };
    const boot = () => startGateway(join(temporary, 'state.sqlite'), home, models.url, '', extra);
    gateway = await boot(); let base = `http://127.0.0.1:${gateway.port}`;
    let rpc = createORPCClient(new RPCLink({ url: base, headers: authHeaders }));
    assert.equal((await fetch(base + '/rpc/inbox/list', { method: 'POST' })).status, 401);
    for (const id of ['sample-ts', 'computer-fake', 'computers-mcp', 'memory-local', 'models', 'engine-t3', 'engine-dsh', 'coding-workflow', 'engine-hermes', 'channels', 'engine-superagent']) {
      const result = await rpc.extensions.enable({ id }); assert.equal(result.status, 'running', `${id}: ${result.reason ?? gateway.errors()}`);
    }
    console.log('P6-9_SETUP extensions running');
    await rpc.x.models.providers.put({ id: 'p69-scripted', kind: 'openai-compatible', baseUrl: models.url, apiKey: 'fake-p69-model-only' });
    for (const [role, model] of [['default', 'fake-model'], ['coding', 'p69-worker'], ['eval', 'p69-eval']]) await rpc.x.models.roles.set({ role, providerId: 'p69-scripted', model });
    await rpc.x['coding-workflow'].register(); console.log('P6-9_SETUP coding provider registered');
    await rpc.inbox.acceptMode.set({ mode: 'act' });
    const bot = await rpc.agents.bots.create({ name: 'P6-9 scripted bot' });
    await rpc.inbox.github.configure({ repositories: [{ name: 'test/project', ref: 'main' }], botId: bot.id, token: 'fake-p69-github-only' });
    await rpc.x['engine-hermes'].profiles.create({ name: 'watest' });
    const profileHome = join(home, 'profiles/watest'); const session = join(profileHome, 'platforms/whatsapp/session');
    await mkdir(session, { recursive: true }); await writeFile(join(session, 'creds.json'), '{"fake":true}\n');
    console.log('P6-9_SETUP connecting fake WhatsApp');
    await rpc.x.channels.connect({ profile: 'watest', platform: 'whatsapp', botId: bot.id });
    await rpc.x.channels.allow({ profile: 'watest', platform: 'whatsapp', senderId: '15550001111', role: 'member' });
    await assert.rejects(rpc.x.channels.notification.resolve({ profile: 'watest', senderId: '15550009999', botId: bot.id }));
    await assert.rejects(rpc.x.channels.notification.resolve({ profile: 'watest', senderId: '15550001111', botId: 'other-bot' }));
    await assert.rejects(rpc.inbox.github.pullRequest({ repo: 'other/private', branch: 'main', commit: 'a'.repeat(40) }));
    const { parse } = createRequire(join(repo, 'extensions/channels/package.json'))('yaml');
    const bridge = async path => {
      const config = parse(await readFile(join(profileHome, 'config.yaml'), 'utf8'));
      const token = (await readFile(join(session, '.bridge-token'), 'utf8')).trim();
      const response = await fetch(`http://127.0.0.1:${config.platforms.whatsapp.extra.bridge_port}${path}`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200); return response.json();
    };
    await eventually(async () => (await bridge('/health')).status === 'connected', 'fake WhatsApp bridge');
    chrome = await startChrome(join(temporary, 'chrome'));
    const openInbox = () => pageSession(chrome, `http://127.0.0.1:${previewPort}/inbox?gateway=${encodeURIComponent(base)}&token=${encodeURIComponent(AUTH)}`);
    page = await openInbox(); console.log('P6-9_SETUP App navigated'); await page.eventually('!!document.querySelector(".inbox-page")', 'App Inbox');
    const type = async (selector, text) => page.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(text)}); e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    const submit = async text => {
      await type('.inbox-composer textarea', text);
      await page.evaluate(`document.querySelector('.inbox-modes input[value=act]').click()`);
      await page.eventually(`(() => { const e=document.querySelector('.inbox-composer button[type=submit]'); return e && !e.disabled && e.getAttribute('aria-disabled')!=='true'; })()`, 'Ask Neo enabled');
      await page.evaluate(`document.querySelector('.inbox-composer button[type=submit]').click()`);
      const item = await eventually(async () => (await rpc.inbox.list()).find(i => i.text === text && ['ready', 'failed', 'blocked', 'question'].includes(i.status)), text, 180000);
      assert.equal(item.status, 'ready', JSON.stringify(item.report)); return item;
    };
    await page.eventually('!document.querySelector("[data-testid=inbox-notify]").disabled', 'notification control enabled');
    console.log('P6-9_SETUP notification toggle'); await page.evaluate('document.querySelector("[data-testid=inbox-notify]").click()');
    await page.eventually('!!document.querySelector("[data-testid=inbox-notify-profile]")', 'notification fields');
    await type('[data-testid=inbox-notify-profile]', 'watest'); await type('[data-testid=inbox-notify-number]', '15550001111');
    console.log('P6-9_SETUP submitting coding request');
    const build = await submit('Build X and tell me on WhatsApp when the PR is up in test/project.');
    assert.equal(build.report.summary, 'PR is up: https://github.com/test/project/pull/7');
    const prepared = models.seen.flatMap(c => c.messages ?? []).filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return null; } }).find(m => m?.descriptionFile);
    assert.ok(prepared?.threadId); assert.equal(prepared.commit, git(prepared.worktree, ['rev-parse', 'HEAD']));
    assert.equal(await readFile(join(prepared.worktree, 'feature.mjs'), 'utf8'), 'console.log("P69_FEATURE_OK");\n');
    assert.ok((await readFile(prepared.descriptionFile, 'utf8')).includes(prepared.commit));
    assert.ok(github.confirmations.includes(prepared.commit)); assert.ok(github.requests.every(r => r.method === 'GET'));
    await eventually(async () => (await bridge('/__test/sent')).some(m => m.chatId === '15550001111@s.whatsapp.net' && m.message === build.report.summary), 'WhatsApp confirmed PR report');
    await eventually(async () => (await rpc.inbox.list()).find(i => i.id === build.id)?.notification?.deliveredAt, 'persisted delivery acknowledgement');
    await page.eventually('document.body.innerText.includes("WhatsApp notification sent")', 'App notification acknowledgement');
    console.log('P6-9_SCENARIO_1 PASS app_request=true real_superagent_T3_DSH=true worktree_feature=true local_PR_commit=true fake_GitHub_confirmation=true fake_WhatsApp_delivery=true');
    await page.eventually('!document.querySelector("[data-testid=inbox-notify]").disabled', 'notification control enabled');
    console.log('P6-9_SETUP notification toggle'); await page.evaluate('document.querySelector("[data-testid=inbox-notify]").click()');
    const computer = await rpc.computers.attach({ providerId: 'computer-fake', target: 'p69-screen' });
    await rpc.computers.assign({ engine: 'hermes', targetId: 'neo_' + bot.id.replace(/-/g, '').toLowerCase(), computerId: computer.id });
    const job = await rpc.inbox.cron.create({ botId: bot.id, text: 'Research Y on my computer every Monday', schedule: '0 9 * * 1', mode: 'act' });
    await rpc.inbox.cron.fire({ id: job.id });
    const research = await eventually(async () => (await rpc.inbox.list()).find(i => i.source === 'neo/cron' && i.text === job.text && ['ready', 'failed', 'blocked'].includes(i.status)), 'Monday research', 120000);
    assert.equal(research.status, 'ready', JSON.stringify(research.report));
    const calls = await (await fetch(base + '/x/computer-fake/calls', { headers: authHeaders() })).json();
    assert.ok(calls.some(c => c.action === 'capture' && c.computerId === 'p69-screen'));
    assert.ok(models.seen.some(c => JSON.stringify(c.messages).includes('mcp__neo_computers__screenshot')));
    await page.eventually('document.body.innerText.includes("Monday research report")', 'MCP research report in Inbox');
    console.log('P6-9_SCENARIO_2 PASS cron_Monday=true real_bot_MCP=true fake_computer_capture=true app_Inbox_report=true');
    await submit('Remember Z: p69-zebra-rendezvous is cobalt orchard.');
    const memories = await rpc.x['memory-local'].list({ workspace: 'default' });
    assert.ok(memories.some(m => m.source === 'superagent.remember' && m.subject_id === 'global' && m.text.includes('cobalt orchard')));
    const recall = await submit('Recall p69-zebra-rendezvous using my bot.');
    assert.match(recall.report.summary, /cobalt orchard/);
    assert.ok(models.seen.some(c => c.model === 'fake-model' && JSON.stringify(c.messages).includes('cobalt orchard') && JSON.stringify(c.messages).includes('memory-context')));
    console.log('P6-9_SCENARIO_3 PASS app_remember=true explicit_shared_write=true later_Hermes_turn_recall=true private_scope_filter_preserved=true');
    await page.close(); page = undefined; await gateway.close(); gateway = undefined;
    gateway = await boot(); base = `http://127.0.0.1:${gateway.port}`; rpc = createORPCClient(new RPCLink({ url: base, headers: authHeaders }));
    const persisted = await rpc.inbox.list(); assert.ok(persisted.find(i => i.id === build.id)?.notification?.deliveredAt);
    assert.ok(persisted.some(i => i.id === research.id && i.report?.summary === research.report.summary));
    assert.ok((await rpc.inbox.cron.list()).some(j => j.id === job.id && j.schedule === '0 9 * * 1'));
    assert.ok((await rpc.x['engine-t3'].threads.list()).threads.some(t => t.id === prepared.threadId));
    await eventually(async () => (await bridge('/health')).status === 'connected', 'WhatsApp after restart');
    assert.ok(!(await bridge('/__test/sent')).some(m => m.message === build.report.summary), 'Acknowledged notifications must not replay');
    await rpc.x.models.roles.set({ role: 'coding', providerId: 'p69-scripted', model: 'p69-memory-reader' });
    const reader = await rpc.x['engine-dsh'].create({ workspaceId: 'default', cwd: coding.root, plugins: { skills: false, report: false } });
    try {
      await rpc.x['engine-dsh'].prompt({ sessionId: reader.sessionId, text: 'p69-zebra-rendezvous' }); await rpc.x['engine-dsh'].wait({ sessionId: reader.sessionId });
      assert.ok(models.seen.some(c => c.model === 'p69-memory-reader' && JSON.stringify(c.messages).includes('cobalt orchard') && JSON.stringify(c.messages).includes('memory-context')));
    } finally { await rpc.x['engine-dsh'].shutdown({ sessionId: reader.sessionId }); }
    console.log('P6-9_RESTART PASS coding_thread=true report=true cron=true delivery_ack=true no_duplicate_notification=true later_DSH_memory_recall=true');
    await rpc.extensions.disable({ id: 'engine-superagent' });
    await rpc.extensions.disable({ id: 'channels' });
    for (const method of ['GET', 'POST']) {
      assert.equal((await fetch(base + '/x/channels/notification/resolve', { method, headers: authHeaders() })).status, 404);
    }
    assert.equal((await fetch(base + '/x/sample-ts/hello', { headers: authHeaders() })).status, 200);
    assert.equal((await rpc.extensions.list()).find(e => e.id === 'engine-hermes').status, 'running');
    console.log('P6-9 PASS authenticated=true build_first=true scripted_models=true isolated_engines=true fake_WhatsApp_GitHub_computers=true three_exit_scenarios=true restart=true disable_isolation=true');
  } catch (error) { console.error('P6-9_SCENARIO_ERROR', error.stack ?? error); console.error('P6-9_GATEWAY_DIAGNOSTIC', gateway?.errors().slice(-1800)); throw error; }
  finally {
    if (page) await page.close().catch(() => {}); chrome?.close();
    const cleanup = await Promise.allSettled([gateway?.close(), coding?.close()]);
    for (const result of cleanup) if (result.status === 'rejected') console.error('P6-9_CLEANUP_ERROR', result.reason);
    await Promise.all([new Promise(done => models.server.close(done)), github ? new Promise(done => github.server.close(done)) : Promise.resolve()]);
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
try {
  nodeTool(app, 'vite/bin/vite.js', ['build']);
  const port = await freePort();
  const preview = spawn(process.execPath, [join(app, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: app, stdio: 'ignore', windowsHide: true });
  try { await awaitHttp(`http://127.0.0.1:${port}/inbox`, 'App preview'); await trial(port); }
  finally { if (process.platform === 'win32') spawnSync(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(preview.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else preview.kill(); }
} catch (error) { console.error('P6-9 FAIL', error.stack ?? error); process.exitCode = 1; }
