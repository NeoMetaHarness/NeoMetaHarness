import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '../..');
const gatewayDir = join(repo, 'apps/gateway');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function cacheRoot() {
  if (process.env.NMH_UPSTREAM_CACHE) return process.env.NMH_UPSTREAM_CACHE;
  for (let path = repo; ; path = dirname(path)) {
    const candidate = join(path, 'nmh-upstream-cache');
    if (existsSync(candidate)) return candidate;
    if (dirname(path) === path) throw new Error('Pinned upstream cache missing');
  }
}

function buildFirst() {
  for (const folder of ['packages/ui', 'apps/gateway', 'apps/neo-app', 'extensions/engine-dsh',
    'extensions/engine-superagent', 'extensions/skills-registry']) {
    const cwd = join(repo, folder);
    execFileSync(process.execPath, [join(cwd, 'node_modules/typescript/bin/tsc'), '--noEmit'],
      { cwd, stdio: 'pipe' });
  }
  execFileSync(process.execPath, [join(app, 'node_modules/vite/bin/vite.js'), 'build'],
    { cwd: app, stdio: 'pipe' });
  assert.ok(existsSync(join(app, 'dist/index.html')));
  console.log('P5-6_BUILD PASS');
}

async function startGateway(temp) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: gatewayDir, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    env: { ...process.env, NODE_ENV: 'test', NMH_UPSTREAM_CACHE: cacheRoot(),
      NMH_SUPERAGENT_TEST_ADAPTER: new URL('../../../extensions/engine-superagent/test/scripted-models.ts', import.meta.url).href,
      NMH_DB_PATH: join(temp, 'neo.sqlite'), NMH_EXTENSIONS_DIR: join(repo, 'extensions'),
      NMH_PORT: '0', NEO_MODE: 'desktop', NEO_PRINT_DESKTOP_TOKEN: '1' },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-3000); });
  const ready = await new Promise((done, reject) => {
    let token;
    const timer = setTimeout(() => reject(new Error(`Gateway startup timed out: ${stderr}`)), 25000);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (line.startsWith('NEO_DESKTOP_TOKEN ')) token = line.slice(18).trim();
      if (line.startsWith('GATEWAY_READY ')) {
        clearTimeout(timer);
        lines.close();
        done({ port: JSON.parse(line.slice(14)).port, token });
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Gateway exited ${code}: ${stderr}`)));
  });
  assert.ok(ready.token?.length > 20, 'Gateway desktop token missing');
  return { ...ready, errors: () => stderr, async close() {
    if (child.exitCode !== null) return;
    const exited = new Promise((done) => child.once('exit', done));
    child.send('shutdown');
    await Promise.race([exited, sleep(15000).then(() => { throw new Error(stderr || 'Gateway shutdown timed out'); })]);
    assert.equal(child.exitCode, 0, stderr);
  } };
}

async function bounded(promise, label, ms = 90000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function eventually(check, label) {
  for (let i = 0; i < 50; i++) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`${label} missing`);
}

async function trial() {
  const temp = await mkdtemp(join(tmpdir(), 'nmh-p5-6-'));
  let gateway;
  let rpc;
  const sessions = [];
  try {
    gateway = await startGateway(temp);
    const base = `http://127.0.0.1:${gateway.port}`;
    const headers = { authorization: `Bearer ${gateway.token}` };
    rpc = createORPCClient(new RPCLink({ url: base, headers: () => headers }));
    assert.notEqual((await fetch(base + '/x/engine-dsh/create', { method: 'POST' })).status, 200);
    for (const id of ['sample-ts', 'memory-local', 'skills-registry', 'engine-superagent', 'engine-dsh']) {
      const status = await rpc.extensions.enable({ id });
      assert.equal(status.status, 'running', `${id}: ${status.reason ?? gateway.errors()}`);
    }

    const workspaceId = 'p56';
    const memory = rpc.x['memory-local'];
    await memory.add({ workspace: workspaceId, subject: 'user', subjectId: 'global',
      text: 'The research keyword is violet puffins.', source: 'p5-6', provenance: 'test' });
    await memory.add({ workspace: workspaceId, subject: 'bot', subjectId: 'neo-coding',
      text: 'You are the patient and exact Neo coding assistant.', source: 'p5-6', provenance: 'test' });

    const dsh = rpc.x['engine-dsh'];
    const active = await bounded(dsh.create({ workspaceId, cwd: temp }), 'DSH create');
    sessions.push(active.sessionId);
    const root = join(temp, 'extensions/engine-dsh');
    const states = await readdir(root);
    assert.equal(states.length, 1, 'Expected one isolated DSH profile');
    const state = join(root, states[0]);
    const modelInputs = async () => (await readFile(join(state, 'home/scripted-model-input.jsonl'), 'utf8'));

    assert.equal((await fetch(`${base}/internal/memory/context?engine=dsh&profile=${active.sessionId}`)).status, 401,
      'Memory endpoint must require session-scoped token');
    const registry = rpc.x['skills-registry'];
    const reusable = await registry.import({ name: 'p56-reusable', sourceProfile: 'p56',
      content: '---\nname: p56-reusable\ndescription: Fixture procedure\n---\n\nAlways verify VIOLET_SKILL before claiming completion.\n' });
    const high = await registry.import({ name: 'p56-high', sourceProfile: 'p56',
      content: '---\nname: p56-high\ndescription: Elevated fixture\n---\n\nUse HIGH_AUTONOMY_ONLY for elevated work.\n' });
    for (const skill of [reusable, high]) await registry.override({ name: skill.name, reason: 'P5-6 isolated scripted fixture' });
    await registry.autonomy.set({ name: high.name, autonomy: 'auto' });
    const target = { engine: 'dsh', targetId: active.sessionId };
    await registry.assign({ name: reusable.name, ...target, assigned: true });
    await registry.assign({ name: high.name, ...target, assigned: true });
    const skillRoot = join(state, 'home/skills');
    assert.ok(existsSync(join(skillRoot, 'p56-reusable/SKILL.md')));
    assert.ok(!existsSync(join(skillRoot, 'p56-high/SKILL.md')), 'Autonomy ceiling must exclude elevated skill');

    await bounded(dsh.prompt({ sessionId: active.sessionId, text: 'Summarise violet puffins.' }), 'DSH prompt');
    assert.equal((await bounded(dsh.wait({ sessionId: active.sessionId }), 'DSH wait')).status, 'settled');
    const first = await modelInputs();
    assert.match(first, /violet puffins/);
    assert.match(first, /<memory-context>/);
    assert.match(first, /<bot-persona>/);
    assert.match(first, /patient and exact Neo coding assistant/);
    assert.match(first, /VIOLET_SKILL/);
    assert.doesNotMatch(first, /HIGH_AUTONOMY_ONLY/);
    const reportFile = join(state, 'report.json');
    assert.ok(existsSync(reportFile), `DSH report plugin produced no file: ${gateway.errors()}`);
    const writtenReport = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.match(writtenReport.summary, /Neo scripted DSH SDK reply/);
    const report = await eventually(async () => (await rpc.inbox.list())
      .find((item) => item.source === 'neo/dsh' && item.text === 'Summarise violet puffins.'),
    `DSH Inbox report (${gateway.errors()})`);
    assert.equal(report.mode, 'observe');
    assert.equal(report.status, 'ready');
    assert.match(report.report.summary, /Neo scripted DSH SDK reply/);
    console.log('P5-6_PROJECT PASS memory=soul=skills report=inbox token=scoped');

    await registry.ceiling.set({ ...target, ceiling: 'auto' });
    assert.ok(existsSync(join(skillRoot, 'p56-high/SKILL.md')));
    await bounded(dsh.prompt({ sessionId: active.sessionId, text: 'Repeat with elevated skill.' }), 'DSH second prompt');
    await bounded(dsh.wait({ sessionId: active.sessionId }), 'DSH second wait');
    assert.match(await modelInputs(), /HIGH_AUTONOMY_ONLY/);
    console.log('P5-6_AUTONOMY PASS ceiling=suggest/auto');

    const quiet = await bounded(dsh.create({ workspaceId, cwd: temp,
      plugins: { memory: false, soul: false, skills: false, report: false } }), 'DSH quiet create');
    sessions.push(quiet.sessionId);
    const quietState = (await readdir(root)).find((name) => name !== states[0]);
    assert.ok(quietState);
    await bounded(dsh.prompt({ sessionId: quiet.sessionId, text: 'Quiet plugin check.' }), 'quiet prompt');
    await bounded(dsh.wait({ sessionId: quiet.sessionId }), 'quiet wait');
    const quietInput = await readFile(join(root, quietState, 'home/scripted-model-input.jsonl'), 'utf8');
    for (const forbidden of ['<memory-context>', '<bot-persona>', '<neo-registry-skills>']) {
      assert.ok(!quietInput.includes(forbidden), `${forbidden} present with plugin disabled`);
    }
    assert.ok(!(await rpc.inbox.list()).some((item) => item.source === 'neo/dsh' && item.text === 'Quiet plugin check.'));
    console.log('P5-6_TOGGLES PASS four_plugins=independent');

    for (const id of ['memory-local', 'skills-registry', 'engine-superagent']) {
      assert.equal((await rpc.extensions.disable({ id })).status, 'disabled');
      await bounded(dsh.prompt({ sessionId: active.sessionId, text: `Healthy with ${id} disabled.` }), 'degraded prompt');
      await bounded(dsh.wait({ sessionId: active.sessionId }), 'degraded wait');
      assert.deepEqual(await (await fetch(`${base}/x/sample-ts/hello`, { headers })).json(),
        { message: 'Hello from TypeScript' });
    }
    console.log('P5-6_EXTENSION_DISABLE PASS dsh=healthy other_extension=healthy');
    console.log('P5-6_EXIT PASS');
  } finally {
    if (rpc) for (const sessionId of sessions.reverse()) {
      await rpc.x['engine-dsh'].shutdown({ sessionId }).catch(() => {});
    }
    if (gateway) await gateway.close();
    await rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
}

buildFirst();
await trial();
