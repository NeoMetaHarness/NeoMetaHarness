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
    env: { ...process.env, NMH_DB_PATH: dbFile, NMH_HERMES_HOME: hermesHome, NMH_HERMES_MODEL_URL: modelUrl, NMH_EXTENSIONS_DIR: join(repo, 'extensions'), NMH_PORT: '0' },
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
  return { port, child, errors: () => errors, async close() {
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
  for (const name of ['engine-hermes', 'engine-dsh', 'skills-registry']) {
    nodeTool(join(repo, 'extensions', name), 'typescript/bin/tsc', ['--noEmit']);
  }
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

async function runHermes(rpc, base, profile, kind) {
  const result = kind === 'learn'
    ? await rpc.x['engine-hermes'].skills.learn({ profile, description: 'A workflow for the papaya checksum protocol' })
    : await rpc.x['engine-hermes'].runs.start({ profile, input: `Apply the papaya checksum protocol, ${profile}` });
  const socket = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  try {
    const { RPCLink: WsLink } = await import('@orpc/client/websocket');
    const client = createORPCClient(new WsLink({ websocket: socket }));
    const events = [];
    for await (const event of await client.x['engine-hermes'].runs.events({ profile, runId: result.run_id })) {
      events.push(event);
      if (['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(event.type)) break;
    }
    assert.ok(events.some((event) => event.type === 'run.completed'), JSON.stringify(events.slice(-5)));
  } finally { socket.close(); }
}

async function trial(previewPort) {
  const temporary = await mkdtemp(join(tmpdir(), 'nmh-p4-3-'));
  const model = await fakeModel();
  let gateway;
  let chrome;
  try {
    gateway = await startGateway(join(temporary, 'state.sqlite'), join(temporary, 'hermes-home'),
      `http://127.0.0.1:${model.port}/v1`);
    const base = `http://127.0.0.1:${gateway.port}`;
    const rpc = createORPCClient(new RPCLink({ url: base }));
    for (const id of ['sample-ts', 'engine-hermes', 'engine-dsh', 'skills-registry']) {
      const response = await rpc.extensions.enable({ id });
      assert.equal(response.status, 'running', `${id}: ${response.reason}`);
    }
    const profiles = rpc.x['engine-hermes'].profiles;
    await profiles.create({ name: 'bota' });
    await profiles.create({ name: 'botb' });
    await runHermes(rpc, base, 'bota', 'learn');
    const registry = rpc.x['skills-registry'];
    let imported = [];
    for (let retry = 0; retry < 30; retry++) {
      await registry.sync({ profile: 'bota' });
      imported = await registry.list();
      if (imported.some((item) => item.name === 'neo-learned-workflow')) break;
      await sleep(200);
    }
    const skill = imported.find((item) => item.name === 'neo-learned-workflow');
    assert.ok(skill, 'Hermes skill_manage did not write a skill in bot A home');
    assert.equal(skill.version, 1);
    assert.equal(skill.sourceProfile, 'bota');
    assert.ok(skill.sourcePath.includes('bota') && skill.sourcePath.endsWith('SKILL.md'));
    assert.equal((await registry.versions({ name: skill.name })).length, 1);
    console.log('P4-3_STAGE learned and imported bot A skill at version 1 with provenance');

    chrome = await startChrome(join(temporary, 'chrome'));
    const page = await pageSession(chrome, `http://127.0.0.1:${previewPort}/skills?gateway=${encodeURIComponent(base)}`);
    try {
      await page.eventually('!!document.querySelector("[data-testid=skills-page]")', 'Skills lazy route');
      await page.evaluate('document.querySelector("[data-testid=registry-tab]").click()');
      await page.eventually('!!document.querySelector("[data-testid=registry-panel]")', 'Registry tab');
      await page.eventually('!!document.querySelector("[data-testid=registry-skill-neo-learned-workflow]")', 'Registry skill');
      await page.evaluate('document.querySelector("[data-testid=registry-skill-neo-learned-workflow] button").click()');
      await page.eventually('document.querySelector("[data-testid=registry-details]")?.textContent.includes("1 versions")', 'Registry version listing');
      await page.evaluate(`(() => {
        const input = document.querySelector('[data-testid=registry-target]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'botb');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await page.eventually('!document.querySelector("[data-testid=registry-assign]").disabled', 'assign enabled');
      await page.evaluate('document.querySelector("[data-testid=registry-assign]").click()');
      await page.eventually('document.querySelector("[data-testid=registry-assign]")?.textContent === "Unassign"', 'bot B assigned');
      assert.ok((await registry.assignments()).some((item) => item.name === skill.name && item.targetId === 'botb'));
      const beforeB = model.calls.length;
      await runHermes(rpc, base, 'botb', 'run');
      const botBInput = JSON.stringify(model.calls.slice(beforeB));
      assert.ok(botBInput.includes('neo-learned-workflow'), `Bot B model request lacks skill. ${botBInput.slice(0, 2500)}`);
      console.log('P4-3_STAGE bot B model saw projected skill');

      const dsh = await rpc.x['engine-dsh'].create({ workspaceId: 'default', cwd: temporary });
      const dshRoot = join(temporary, 'extensions', 'engine-dsh');
      const dshDirs = await (await import('node:fs/promises')).readdir(dshRoot);
      assert.equal(dshDirs.length, 1, 'Expected one isolated DSH state directory');
      const dshHome = join(dshRoot, dshDirs[0], 'home');
      await registry.assign({ name: skill.name, engine: 'dsh', targetId: dsh.sessionId, assigned: true });
      const projected = join(dshHome, 'skills', skill.name);
      assert.ok((await readFile(join(projected, 'SKILL.md'), 'utf8')).includes('Check the inputs'));
      await rpc.x['engine-dsh'].prompt({ sessionId: dsh.sessionId, text: 'Apply neo-learned-workflow to the papaya checksum protocol' });
      await rpc.x['engine-dsh'].wait({ sessionId: dsh.sessionId });
      const rawTrace = await readFile(join(dshHome, 'scripted-model-input.jsonl'), 'utf8');
      assert.ok(rawTrace.includes('neo-learned-workflow'), `DSH actual model message omitted registered skill: ${rawTrace.slice(0, 4000)}`);
      console.log('P4-3_STAGE DSH model received skill via DSH_HOME/skills');

      const original = (await registry.get({ name: skill.name })).content;
      const changed = original.replace('Check the inputs.', 'Check the papaya checksum twice.');
      assert.notEqual(changed, original);
      const v2 = await registry.import({ name: skill.name, content: changed, sourceProfile: 'bota', sourcePath: skill.sourcePath, trust: 'observed' });
      assert.equal(v2.version, 2);
      const diff = await registry.diff({ name: skill.name, from: 1, to: 2 });
      assert.ok(diff.diff.includes('papaya checksum twice'));
      await page.evaluate('document.querySelector("[data-testid=registry-skill-neo-learned-workflow] button").click()');
      await page.eventually('document.querySelector("[data-testid=registry-details]")?.textContent.includes("2 versions")', 'v2 in Registry UI');
      await page.evaluate('document.querySelector("[data-testid=registry-to]").value = "2"');
      await page.evaluate('document.querySelector("[data-testid=registry-diff-button]").click()');
      await page.eventually('document.querySelector("[data-testid=registry-diff]")?.textContent.includes("papaya checksum twice")', 'diff in UI');
      await page.evaluate('document.querySelector("[data-testid=registry-rollback]").click()');
      await page.eventually('document.querySelector("[data-testid=registry-details]")?.textContent.includes("3 versions")', 'rollback in UI');
      const rollback = await registry.get({ name: skill.name });
      assert.equal(rollback.metadata.version, 3);
      assert.equal(rollback.content, original, 'Rollback must restore exact original bytes');
      console.log('P4-3_STAGE diff and rollback create version 3, restoring v1 exact content');

      const metadataOnly = await registry.import({
        name: skill.name, content: original, sourceProfile: 'botb',
        sourcePath: 'reviewed/by/botb', trust: 'confirmed',
      });
      assert.equal(metadataOnly.version, 4);
      assert.equal((await registry.versions({ name: skill.name })).length, 4,
        'Metadata-only revisions must be included in the Git version history');
      const originalRevision = await registry.rollback({ name: skill.name, version: 1 });
      assert.equal(originalRevision.version, 5);
      assert.equal(originalRevision.sourceProfile, 'bota');
      assert.equal(originalRevision.sourcePath, skill.sourcePath);
      assert.equal(originalRevision.trust, 'observed');
      assert.equal((await registry.get({ name: skill.name })).content, original);
      console.log('P4-3_STAGE metadata-only provenance revision and historical rollback verified');

      await rpc.extensions.disable({ id: 'skills-registry' });
      assert.equal((await fetch(base + '/x/skills-registry/list')).status, 404);
      await assert.rejects(readFile(join(temporary, 'hermes-home', 'profiles', 'botb', 'skills', skill.name, 'SKILL.md'), 'utf8'));
      await assert.rejects(readFile(join(projected, 'SKILL.md'), 'utf8'));
      assert.equal((await fetch(base + '/x/sample-ts/hello')).status, 200);
      await runHermes(rpc, base, 'botb', 'run');
      await rpc.x['engine-dsh'].prompt({ sessionId: dsh.sessionId, text: 'Still healthy after registry disable' });
      await rpc.x['engine-dsh'].wait({ sessionId: dsh.sessionId });
      await rpc.x['engine-dsh'].shutdown({ sessionId: dsh.sessionId });
      console.log('P4-3_BROWSER PASS hermes=true dsh=true registry-v3=true rollback=true disabled-404=true other-extensions=true');
    } catch (error) {
      console.error('P4-3_BROWSER FAILURE', error, 'GATEWAY ERRORS', gateway?.errors());
      throw error;
    } finally { await page.close(); }
  } finally {
    chrome?.close();
    if (gateway) await gateway.close();
    model.server.closeAllConnections();
    await new Promise((done) => model.server.close(done));
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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
  console.log('P4-3_EXIT PASS');
} finally {
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(preview.pid), '/T', '/F'], { windowsHide: true });
  else preview.kill();
}
