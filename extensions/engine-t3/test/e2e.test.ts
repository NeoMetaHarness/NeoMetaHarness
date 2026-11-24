import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { WebSocket } from 'ws';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type T3Event } from '@neometaharness/contracts';
import { build, stop as stopEsbuild } from 'esbuild';
import { system32 } from '../src/system-tools.js';
import { installedT3 } from '../src/install.js';
import { pinnedTestT3Cli } from './pinned-cli.js';
import { T3ControlPlane } from '../src/client.js';
import { isolatedT3Environment, T3_SESSION_SCOPES } from '../src/runtime.js';
import { extensionIntegrity } from '@neometaharness/kernel';
import { unsealFixtureTree } from '../../../packages/kernel/test/upgrade-fixtures.js';
import { requireUpstreamCache } from '../../../tests/upstream-cache.mjs';
import { coalesceText } from '../../../apps/gateway/src/coalesce.js';

const here = fileURLToPath(new URL('../', import.meta.url));
const repo = resolve(here, '../..');
const spike = join(repo, 'spikes/P0-3a-t3-headless-client');
const t3Pin = (JSON.parse(readFileSync(join(repo, 'upstream.lock.json'), 'utf8')) as { pins: Record<string, { ref: string; commit: string }> }).pins.t3code!;
const cacheRoot = requireUpstreamCache('extensions/engine-t3/test/e2e.test.ts', ['t3code']);
const upstream = join(cacheRoot, `t3code@${t3Pin.ref}`);
const gatewayDir = join(repo, 'apps/gateway');
type Client = ContractRouterClient<typeof neoContract>;

async function port(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done) => listener.close(() => done()));
  return address.port;
}

function t3(cli: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): ChildProcess {
  return spawn(cli, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function capture(child: ChildProcess): Promise<string> {
  return new Promise((done, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr!.on('data', (data: Buffer) => { stderr += data.toString().slice(0, 3000); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? done(stdout.trim()) : reject(new Error(`T3 CLI exited ${code}: ${stderr}`)));
  });
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  for (let i = 0; i < 150; i++) {
    assert.equal(child.exitCode, null, 'isolated T3 exited before becoming ready');
    try {
      const response = await fetch(url + '/api/auth/websocket-ticket', { method: 'POST', signal: AbortSignal.timeout(1000) });
      if (response.status === 401 || response.status === 403) return;
    } catch { /* The isolated T3 server is still starting. */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('Isolated T3 did not start within 15 seconds');
}

async function gateway(state: string, url = '', session = '', extraEnv: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: gatewayDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NMH_DB_PATH: join(state, 'neo.sqlite'), NMH_EXTENSIONS_DIR: join(repo, 'extensions'),
      NMH_PORT: '0', NMH_ENGINES_DIR: join(state, 'engines'), NMH_T3_URL: url, NMH_T3_SCOPED_SESSION: session, NEO_MODE: 'desktop', NEO_PRINT_DESKTOP_TOKEN: '1', ...extraEnv },
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString().slice(0, 3000); });
  let token = '';
  const ready = await new Promise<number>((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gateway start timeout: ${stderr}`)), 20000);
    const reader = createInterface({ input: child.stdout! });
    reader.on('line', (line) => {
      if (line.startsWith('NEO_DESKTOP_TOKEN ')) token = line.slice('NEO_DESKTOP_TOKEN '.length).trim();
      if (line.startsWith('GATEWAY_READY ')) {
        clearTimeout(timer);
        reader.close();
        done((JSON.parse(line.slice(14)) as { port: number }).port);
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Gateway exited ${code}: ${stderr}`)));
  });
  return { child, ready, token, get error() { return stderr; } };
}

async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function stop(child?: ChildProcess, graceful = false): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  if (graceful && child.connected) child.send('shutdown');
  else if (process.platform === 'win32' && child.pid) {
    await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, timeout: 5000 }).catch(() => child.kill());
  } else child.kill();
  try { await within(exited, 8000, 'process shutdown'); }
  catch {
    child.kill('SIGKILL');
    await within(exited, 5000, 'forced process shutdown');
  }
}

function t3SocketAddresses(serverPort: number, gatewayPid: number): string[] {
  const output = execFileSync(system32('netstat.exe'), ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
  return output.split(/\r?\n/).filter((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[0] === 'TCP' && fields[2] === `127.0.0.1:${serverPort}` &&
      fields[3] === 'ESTABLISHED' && Number(fields[4]) === gatewayPid;
  }).map((line) => line.trim().split(/\s+/)[1]);
}

function connectedT3Sockets(serverPort: number, gatewayPid: number): number {
  return t3SocketAddresses(serverPort, gatewayPid).length;
}

async function buildWireBundle(cache: string) {
  await mkdir(cache, { recursive: true });
  const bundle = join(cache, 'pinned-wire.bundle.mjs');
  await build({
    entryPoints: [join(here, 'test/wire.entry.ts')], outfile: bundle, bundle: true,
    platform: 'node', target: 'node22', format: 'esm', nodePaths: [join(here, 'node_modules')],
    plugins: [{ name: 'pinned-t3-schema-only', setup(builder) {
      const source = {
        '@t3tools/contracts': 'packages/contracts/src/index.ts',
        '@t3tools/contracts/relay': 'packages/contracts/src/relay.ts',
        '@t3tools/client-runtime/rpc-protocol': 'packages/client-runtime/src/rpc/protocol.ts',
      } as Record<string, string>;
      builder.onResolve({ filter: /^@t3tools\// }, (args) => source[args.path]
        ? { path: join(upstream, source[args.path]) } : undefined);
    } }],
  });
  return bundle;
}

async function main() {
  await assert.rejects(new T3ControlPlane().connect('http://192.0.2.1', 'isolated-fixture-token'), /HTTPS origin/);
  await assert.rejects(new T3ControlPlane().connect('http://127.example.invalid', 'isolated-fixture-token'), /HTTPS origin/);
  console.log('T3_ORIGIN PASS remote_http=refused');
  async function* syntheticEvents(): AsyncGenerator<T3Event> {
    yield { kind: 'text.delta', sequence: 1, textDelta: 'part ' };
    yield { kind: 'text.delta', sequence: 2, textDelta: 'one' };
    yield { kind: 'event', sequence: 3, type: 'runtime-request.updated', payload: { status: 'pending' } };
    yield { kind: 'text.delta', sequence: 4, textDelta: 'two' };
    await new Promise((done) => setTimeout(done, 60));
    yield { kind: 'text.delta', sequence: 5, textDelta: 'three' };
  }
  const batched = await Array.fromAsync(coalesceText(syntheticEvents(), 33));
  assert.deepEqual(batched.map(({ sequence, textDelta, coalescedCount }) =>
    ({ sequence, textDelta, coalescedCount })), [
    { sequence: 2, textDelta: 'part one', coalescedCount: 2 },
    { sequence: 3, textDelta: undefined, coalescedCount: undefined },
    { sequence: 4, textDelta: 'two', coalescedCount: 1 },
    { sequence: 5, textDelta: 'three', coalescedCount: 1 },
  ]);
  const distinct = await Array.fromAsync(coalesceText((async function* (): AsyncGenerator<T3Event> {
    yield { kind: 'text.delta', sequence: 1, messageId: 'first', textDelta: 'a' };
    yield { kind: 'text.delta', sequence: 2, messageId: 'second', textDelta: 'b' };
  })(), 33));
  assert.deepEqual(distinct.map((event) => event.textDelta), ['a', 'b'],
    'coalescing must respect message identity');
  console.log('T3_COALESCE PASS interval=33ms merge=2 ordered_control=true message_ids=isolated');
  assert.equal(execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), t3Pin.commit);
  const temp = await mkdtemp(join(tmpdir(), 'nmh-t3-isolated-'));
  const cache = join(here, 'test/.cache');
  let server: ChildProcess | undefined;
  let app: Awaited<ReturnType<typeof gateway>> | undefined;
  let socket: WebSocket | undefined;
  try {
    const environment = await isolatedT3Environment(temp);
    const cli = await pinnedTestT3Cli('ENGINE_T3', repo, temp, environment);
    if (!cli) return;
    const bundle = await buildWireBundle(cache);
    const isolatedPort = await port();
    const url = `http://127.0.0.1:${isolatedPort}`;
    const state = environment.T3CODE_HOME!;
    server = t3(cli, ['serve', '--mode', 'desktop', '--host', '127.0.0.1', '--port', String(isolatedPort),
      '--base-dir', state, '--no-browser'], environment, temp);
    await waitForServer(url, server);
    // The same scopes the local runtime requests, so this run proves they cover coding-workflow's worktree.
    const session = await capture(t3(cli, ['auth', 'session', 'issue', '--base-dir', state,
      ...T3_SESSION_SCOPES.flatMap((scope) => ['--scope', scope]),
      '--ttl', '15m', '--label', 'nmh-isolated-test', '--token-only'], environment, temp));
    // A committed scratch repository, so T3 can create a worktree from HEAD.
    const workspace = join(temp, 'workspace');
    await mkdir(workspace, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-C', workspace, '-c', 'user.name=Neo Test',
      '-c', 'user.email=neo-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'scratch');
    assert.ok(session.length > 16, 'isolated session token was not issued');
    const projectId = randomUUID();
    const providerId = 'nmhFakeAcp';
    const setup = spawn(process.execPath, [bundle], {
      cwd: here, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, T3_TEST_URL: url, T3_TEST_SESSION: session,
        T3_TEST_PROVIDER: providerId, T3_TEST_PROJECT: projectId,
        T3_TEST_WORKSPACE: workspace, T3_TEST_FAKE_ACP: join(spike, 'fake-acp.mjs') },
    });
    const setupOutput = await within(capture(setup), 20000, 'T3 pinned setup');
    assert.match(setupOutput, /T3_WIRE_SCHEMAS PASS/);
    assert.match(setupOutput, /T3_ISOLATED_SETUP PASS/);
    console.log(setupOutput);

    app = await gateway(temp, url, session);
    const token = app.token;
    const base = `http://127.0.0.1:${app.ready}`;
    const http = createORPCClient<Client>(new HttpLink({ url: base, headers: () => ({ authorization: `Bearer ${token}` }) }));
    socket = new WebSocket(`ws://127.0.0.1:${app.ready}/ws`, ['bearer.' + token]);
    const ws = createORPCClient<Client>(new WebSocketLink({ websocket: socket }));
    assert.equal((await http.extensions.enable({ id: 'sample-ts' })).status, 'running');
    assert.equal((await http.extensions.enable({ id: 'engine-t3' })).status, 'running', app.error);
    assert.equal((await http.x['engine-t3'].runtime.start()).state, 'ready');
    const deadline = Date.now() + 15_000;
    while (!(await http.x['engine-t3'].install.status()).connected) {
      assert.ok(Date.now() < deadline, 'external T3 connection timed out');
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(connectedT3Sockets(isolatedPort, app.child.pid!) >= 1,
      'T3 gateway must own a live TCP/WebSocket connection');
    const threadId = randomUUID();
    assert.ok((await http.x['engine-t3'].create({ threadId, projectId, title: 'Isolated fake test',
      providerId, model: 'default' })).sequence > 0);

    const synchronized = Promise.withResolvers<void>();
    const runComplete = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    const events: T3Event[] = [];
    const text: string[] = [];
    let pending = false;
    let resolved = false;
    let declined = false;
    const listening = (async () => {
      for await (const event of await ws.x['engine-t3'].events({ threadId })) {
        events.push(event);
        if (event.kind === 'snapshot' || event.kind === 'synchronized') synchronized.resolve();
        if (event.kind === 'text.delta') text.push(event.textDelta ?? '');
        if (event.kind === 'event' && event.type === 'runtime-request.updated') {
          const request = event.payload as { id: string; status: string };
          if (request.status === 'pending' && !pending) {
            pending = true;
            assert.ok((await http.x['engine-t3'].approval({ threadId, requestId: request.id,
              decision: 'decline' })).sequence > 0);
            declined = true;
          }
          if (request.status === 'resolved') resolved = true;
        }
        if (event.kind === 'event' && event.type === 'run.updated' &&
          (event.payload as { status: string }).status === 'completed') runComplete.resolve();
        if (event.kind === 'event' && event.type === 'thread.settled') { settled.resolve(); return; }
      }
    })();
    const checkedListening = listening.catch((error) => {
      synchronized.reject(error); runComplete.reject(error); settled.reject(error);
      throw error;
    });
    await within(synchronized.promise, 20000, 'thread subscription');
    assert.ok((await http.x['engine-t3'].send({ threadId, text: 'Return fake text and ask permission.' })).sequence > 0);
    await within(runComplete.promise, 40000, 'fake ACP run');
    assert.ok((await http.x['engine-t3'].settle({ threadId })).sequence > 0);
    await within(settled.promise, 15000, 'thread settled event');
    await within(checkedListening, 5000, 'thread stream completion');
    assert.equal(text.join(''), 'neo fake streamed text, part two. Approval declined.');
    const snapshot = events.find((event) => event.kind === 'snapshot');
    assert.ok(snapshot?.payload && typeof (snapshot.payload as { projection?: unknown }).projection === 'object',
      'the gateway must retain the initial thread projection');
    assert.ok(pending && declined && resolved, 'approval must be pending, declined and resolved');
    const sequences = events.filter((event) => event.sequence !== undefined).map((event) => event.sequence!);
    assert.ok(sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]),
      'all projected gateway events must be strictly ordered');
    assert.ok(events.some((event) => event.kind === 'text.delta' && event.coalescedCount! >= 1));

    // vcs.createWorktree needs source-control:write (T3 v0.1.9 contracts/clientRpcPermissions.ts:58).
    assert.equal((await http.extensions.enable({ id: 'coding-workflow' })).status, 'running', app.error);
    const worktreeThread = randomUUID();
    await http.x['engine-t3'].create({ threadId: worktreeThread, projectId, title: 'Worktree scope', providerId, model: 'default' });
    const worktree = await http.x['coding-workflow'].worktree({ threadId: worktreeThread, branch: 'neo-scope-check' });
    assert.equal(worktree.branch, 'neo-scope-check');
    assert.ok(existsSync(worktree.path), 'T3 created the worktree');
    await http.extensions.disable({ id: 'coding-workflow' });

    await http.extensions.disable({ id: 'engine-t3' });
    let socketClosed = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (connectedT3Sockets(isolatedPort, app.child.pid!) === 0) { socketClosed = true; break; }
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(socketClosed, 'disabling the extension must close its T3 WebSocket');
    const disabled = await fetch(base + '/x/engine-t3/create', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' });
    assert.equal(disabled.status, 404, 'disabled engine route must disappear');
    assert.equal((await http.extensions.list()).find((entry) => entry.id === 'engine-t3')?.status, 'disabled');
    assert.deepEqual(await (await fetch(base + '/x/sample-ts/hello', { headers: { authorization: `Bearer ${token}` } })).json(), { message: 'Hello from TypeScript' });
    console.log(`T3_GATEWAY_E2E PASS ordered=${sequences.length} chunks=${text.length} approvals=declined settled=true socket=closed worktree=created disable=404 sample=healthy`);
  } finally {
    socket?.close();
    await stop(app?.child, true);
    await stop(server);
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const expectedHomes = {
  HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata',
  XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache', XDG_DATA_HOME: 'data', XDG_STATE_HOME: 'state',
  TEMP: 'tmp', TMP: 'tmp', TMPDIR: 'tmp', T3CODE_HOME: 'state',
  CODEX_HOME: 'codex', CLAUDE_CONFIG_DIR: 'claude', CLAUDE_CODE_PLUGIN_CACHE_DIR: 'claude/plugins',
  GEMINI_HOME: 'gemini', ANTIGRAVITY_DATA_DIR: 'antigravity', GROK_HOME: 'grok', OPENCODE_DATA_DIR: 'data/opencode',
};

async function probeProviderHomes(
  root: string, executable: string, serverPort: number, gatewayClient: Client, forbiddenPath: string,
) {
  const origin = 'http://127.0.0.1:' + serverPort;
  const base = join(root, 'state');
  const { stdout: session } = await promisify(execFile)(executable, ['auth', 'session', 'issue', '--base-dir', base,
    '--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--scope', 'providers:manage',
    '--ttl', '2m', '--label', 'nmh-home-probe', '--token-only'],
  { cwd: root, env: await isolatedT3Environment(root), windowsHide: true, timeout: 30_000 });
  const report = join(root, 'provider-env.json');
  const agent = join(root, 'home-probe.cjs');
  const keys = Object.keys(expectedHomes);
  await writeFile(agent, `
const { renameSync, writeFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const { homedir } = require('node:os');
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  let result = {};
  if (method === 'initialize') {
    const env = Object.fromEntries(${JSON.stringify(keys)}.map((key) => [key, process.env[key]]));
    const reportPath = ${JSON.stringify(report)};
    writeFileSync(reportPath + '.tmp', JSON.stringify({
      env, home: homedir(), inheritedCredential: 'OPENAI_API_KEY' in process.env,
      privatePath: (process.env.PATH || '').split(require('node:path').delimiter).includes(${JSON.stringify(forbiddenPath)}),
    }));
    renameSync(reportPath + '.tmp', reportPath);
    result = { protocolVersion: 2, info: { name: 'isolated-home-probe', version: '1.0.0' }, capabilities: { session: {} } };
  } else if (method === 'session/new') result = { sessionId: 'neo-home-probe', configOptions: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
});
`);
  const projectId = randomUUID();
  const providerId = 'nmhHomeProbe';
  const bundle = await buildWireBundle(join(root, 'probe-bundle'));
  const setup = spawn(process.execPath, [bundle], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...await isolatedT3Environment(root), T3_TEST_URL: origin, T3_TEST_SESSION: session.trim(),
      T3_TEST_PROVIDER: providerId, T3_TEST_PROJECT: projectId, T3_TEST_WORKSPACE: join(root, 'probe-workspace'),
      T3_TEST_FAKE_ACP: agent },
  });
  assert.match(await within(capture(setup), 20_000, 'T3 real provider setup'), /T3_ISOLATED_SETUP PASS/);
  const threadId = randomUUID();
  await gatewayClient.x['engine-t3'].create({ threadId, projectId, providerId, title: 'Home probe', model: 'default' });
  await gatewayClient.x['engine-t3'].send({ threadId, text: 'Read the isolated environment' });
  const deadline = Date.now() + 20_000;
  while (!existsSync(report)) {
    assert.ok(Date.now() < deadline, 'T3 did not launch the isolated provider probe');
    await new Promise((done) => setTimeout(done, 100));
  }
  const observed = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(relative(root, observed.home), 'home');
  for (const [key, path] of Object.entries(expectedHomes)) {
    assert.equal(relative(root, observed.env[key]), join(path), key);
  }
  assert.equal(observed.inheritedCredential, false);
  assert.equal(observed.privatePath, false);
  console.log(`T3_PROVIDER_ENV PASS paths_inside_t3_home=${keys.length} os_home=isolated credential=absent private_path=absent`);
}

type T3Session = { sessionId: string; issuedAt: string; expiresAt: string };

async function t3Sessions(root: string, executable: string): Promise<T3Session[]> {
  const { stdout } = await promisify(execFile)(executable, ['auth', 'session', 'list', '--base-dir', join(root, 'state'), '--json'],
    { cwd: root, env: await isolatedT3Environment(root), windowsHide: true, timeout: 30_000 });
  return JSON.parse(stdout) as T3Session[];
}

/** A run waiting on approval and a terminal stream both outlive a session renewal; the old session is revoked. */
async function streamsAcrossRenewal(root: string, executable: string, serverPort: number,
  app: { ready: number; token: string; child: ChildProcess; error: string }, sessionTtl: number) {
  const http = createORPCClient<Client>(new HttpLink({ url: 'http://127.0.0.1:' + app.ready,
    headers: () => ({ authorization: 'Bearer ' + app.token }) }));
  const environment = await isolatedT3Environment(root);
  const { stdout } = await promisify(execFile)(executable, ['auth', 'session', 'issue', '--base-dir', join(root, 'state'),
    '--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--scope', 'providers:manage',
    '--ttl', '2m', '--label', 'nmh-renewal-setup', '--json'], { cwd: root, env: environment, windowsHide: true, timeout: 30_000 });
  const setupSession = JSON.parse(stdout) as { sessionId: string; token: string };
  const projectId = randomUUID();
  const providerId = 'nmhRenewalAcp';
  const setup = spawn(process.execPath, [await buildWireBundle(join(root, 'renewal-bundle'))], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...environment, T3_TEST_URL: 'http://127.0.0.1:' + serverPort, T3_TEST_SESSION: setupSession.token,
      T3_TEST_PROVIDER: providerId, T3_TEST_PROJECT: projectId, T3_TEST_WORKSPACE: join(root, 'renewal-workspace'),
      T3_TEST_FAKE_ACP: join(spike, 'fake-acp.mjs') },
  });
  assert.match(await within(capture(setup), 20_000, 'T3 renewal setup'), /T3_ISOLATED_SETUP PASS/);
  assert.equal((await http.extensions.enable({ id: 'coding-workflow' })).status, 'running');
  const threadId = randomUUID();
  await http.x['engine-t3'].create({ threadId, projectId, providerId, title: 'Renewal', model: 'default' });

  const sockets: WebSocket[] = [];
  const stream = () => {
    const socket = new WebSocket(`ws://127.0.0.1:${app.ready}/ws`, ['bearer.' + app.token]);
    sockets.push(socket);
    return createORPCClient<Client>(new WebSocketLink({ websocket: socket }));
  };
  const events: T3Event[] = [];
  let threadEnded = false;
  const synchronized = Promise.withResolvers<void>();
  const approval = Promise.withResolvers<string>();
  const completed = Promise.withResolvers<void>();
  const threadStream = (async () => {
    for await (const event of await stream().x['engine-t3'].events({ threadId })) {
      events.push(event);
      if (event.kind === 'snapshot' || event.kind === 'synchronized') synchronized.resolve();
      const payload = event.payload as { id?: string; status?: string } | undefined;
      if (event.type === 'runtime-request.updated' && payload?.status === 'pending') approval.resolve(payload.id!);
      if (event.type === 'run.updated' && payload?.status === 'completed') completed.resolve();
    }
    threadEnded = true;
  })();
  let streamError: unknown;
  for (const pending of [synchronized, approval, completed]) pending.promise.catch(() => {});
  threadStream.catch((error) => { streamError = error; synchronized.reject(error); approval.reject(error); completed.reject(error); });
  await within(synchronized.promise, 20_000, 'thread subscription');
  await http.x['engine-t3'].send({ threadId, text: 'Stream across a session renewal.' });
  const requestId = await within(approval.promise, 40_000, 'run waiting on approval');
  console.log('T3_RENEWAL_STREAMS thread waiting on approval');

  const opened = await http.x['coding-workflow'].terminal.open({ threadId });
  let terminal = '';
  let terminalEnded = false;
  const terminalStream = (async () => {
    for await (const item of await stream().x['coding-workflow'].terminal.output({ threadId, terminalId: opened.terminalId })) {
      const event = item as { type: string; data?: string; snapshot?: { history?: string } };
      terminal += event.type === 'output' ? event.data ?? '' : event.type === 'snapshot' ? event.snapshot?.history ?? '' : '';
    }
    terminalEnded = true;
  })();
  terminalStream.catch((error) => { streamError ??= error; terminalEnded = true; });

  // Renewal replaces the Gateway's T3 socket and revokes the session it used.
  const ownSessions = new Set([setupSession.sessionId]);
  const gatewaySession = (await t3Sessions(root, executable)).filter((session) => !ownSessions.has(session.sessionId))
    .sort((left, right) => Date.parse(right.issuedAt) - Date.parse(left.issuedAt))[0];
  assert.ok(gatewaySession, 'the Gateway holds a T3 session');
  const initial = t3SocketAddresses(serverPort, app.child.pid!);
  const deadline = Date.now() + sessionTtl * 2;
  for (;;) {
    assert.ok(Date.now() < deadline, 'Scoped session did not renew during the streams');
    await new Promise((done) => setTimeout(done, 200));
    const addresses = t3SocketAddresses(serverPort, app.child.pid!);
    if (addresses.length > 0 && !addresses.some((address) => initial.includes(address))) break;
  }
  const afterRenewal = await t3Sessions(root, executable);
  const checkedAt = Date.now();
  assert.ok(!afterRenewal.some((session) => session.sessionId === gatewaySession.sessionId),
    'the replaced Gateway session is revoked');
  assert.ok(checkedAt < Date.parse(gatewaySession.expiresAt), 'revocation, not expiry, removed the replaced session');
  // Outlive the session the streams started on.
  while (Date.now() < Date.parse(gatewaySession.expiresAt) + 500) await new Promise((done) => setTimeout(done, 200));
  assert.equal(threadEnded || !!streamError, false, 'the thread stream continues across the renewal: ' + String(streamError) + '\n' + app.error.slice(-3000));
  assert.equal(terminalEnded, false, 'the terminal stream continues across the renewal');

  const marker = 'NEO_AFTER_RENEWAL';
  await http.x['coding-workflow'].terminal.run({ threadId, command: 'echo ' + marker });
  const approvalSent = http.x['engine-t3'].approval({ threadId, requestId, decision: 'decline' });
  await within(completed.promise, 30_000, 'run completes on the renewed connection');
  await approvalSent;
  const outputDeadline = Date.now() + 15_000;
  while (!terminal.includes(marker)) {
    assert.ok(Date.now() < outputDeadline, 'terminal output after the renewal: ' + JSON.stringify(terminal.slice(-400)));
    await new Promise((done) => setTimeout(done, 200));
  }
  const text = events.filter((event) => event.kind === 'text.delta').map((event) => event.textDelta).join('');
  assert.match(text, /Approval declined\.$/, 'text streamed after the renewal reaches the same transcript');
  assert.equal(events.filter((event) => event.kind === 'snapshot').length, 1, 'the transcript is never reset');
  const sequences = events.filter((event) => event.sequence !== undefined).map((event) => event.sequence!);
  assert.ok(sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]), 'no replayed or reordered events');
  for (const socket of sockets) socket.close();
  await Promise.allSettled([threadStream, terminalStream]);
  console.log(`T3_RENEWAL_STREAMS PASS thread=continued terminal=continued snapshots=1 ordered=${sequences.length} `
    + `previous_session=revoked_before_expiry`);
}

/** Blue/green upgrade while connected: the candidate reuses the running T3 server. */
async function upgradeWhileConnected(temp: string, http: Client, pid: number) {
  const candidate = join(temp, 'engine-t3-candidate');
  await mkdir(candidate, { recursive: true });
  const kernel = join(temp, 'kernel-entry.mjs');
  await writeFile(kernel, `export * from ${JSON.stringify(join(repo, 'packages/kernel/src/engine-source.ts'))};\n`
    + 'export function defineExtension(extension) { return extension; }\n');
  await build({
    entryPoints: [join(here, 'src/index.ts')], outfile: join(candidate, 'index.mjs'), bundle: true,
    platform: 'node', target: 'node22', format: 'esm', nodePaths: [join(here, 'node_modules')],
    banner: { js: "import { createRequire as __neoRequire } from 'node:module'; const require = __neoRequire(import.meta.url);" },
    plugins: [{ name: 'kernel-seams', setup(builder) {
      builder.onResolve({ filter: /^@neometaharness\/kernel$/ }, () => ({ path: kernel }));
    } }],
  });
  const manifest = JSON.parse(readFileSync(join(here, 'neo.extension.json'), 'utf8'));
  await writeFile(join(candidate, 'neo.extension.json'), JSON.stringify({ ...manifest, version: '0.1.1',
    runtime: { ...manifest.runtime, entry: './index.mjs' } }, null, 2));
  const result = await http.extensions.upgrade({ id: 'engine-t3', directory: candidate, integrity: await extensionIntegrity(candidate) });
  assert.equal(result.upgraded, true, result.reason);
  assert.equal(result.reason, undefined, 'the old generation retires cleanly');
  const status = (await http.extensions.list()).find((row) => row.id === 'engine-t3');
  assert.equal(status?.version, '0.1.1');
  // No lock override: the upgraded copy lives in extension storage and finds the lock through the Gateway's runtimeRoot.
  assert.equal((await http.x['engine-t3'].install.status()).state, 'ready');
  assert.equal(status?.health?.ok, true, status?.health?.reason);
  assert.equal(status?.health?.pid, pid, 'the upgraded generation serves from the same T3 server');
  process.kill(pid, 0);
  assert.ok(Array.isArray((await http.x['engine-t3'].threads.list()).threads));
  console.log('T3_UPGRADE PASS staged_while_connected=true same_server=true candidate_healthy=true');
}

// Opt-in smoke for the real release, from a clean installed-app data layout.
async function realInstall() {
  // Long enough to observe the replaced session revoked before it would expire.
  const sessionTtl = 30_000;
  const temp = await mkdtemp(join(tmpdir(), 'nmh-t3-real-release-'));
  const poison = join(temp, 'ambient-codex');
  const forbiddenPath = join(poison, 'bin');
  await mkdir(forbiddenPath, { recursive: true });
  const poisonedPath = forbiddenPath + delimiter + (process.env.Path ?? process.env.PATH ?? '');
  const env = { NODE_ENV: 'test', NMH_TEST_T3_SESSION_TTL_MS: String(sessionTtl),
    OPENAI_API_KEY: 'fixture-value-must-not-be-inherited',
    CODEX_HOME: poison, CLAUDE_CONFIG_DIR: join(temp, 'ambient-claude'), GEMINI_HOME: join(temp, 'ambient-gemini'),
    PATH: poisonedPath, Path: poisonedPath,
  };
  let app: Awaited<ReturnType<typeof gateway>> | undefined;
  let pid: number | undefined;
  let stale: ChildProcess | undefined;
  let other: Awaited<ReturnType<typeof gateway>> | undefined;
  const engines = join(temp, 'engines');
  const root = join(engines, 't3-home');
  const client = () => createORPCClient<Client>(new HttpLink({
    url: 'http://127.0.0.1:' + app!.ready,
    headers: () => ({ authorization: 'Bearer ' + app!.token }),
  }));
  async function confirmConnection(timeout: number) {
    const deadline = Date.now() + timeout;
    while (true) {
      const status = await client().x['engine-t3'].install.status().catch(() => undefined);
      assert.notEqual(status?.state, 'failed', status?.error + '\n' + app?.error);
      if (status?.connected) break;
      assert.ok(status?.phase === 'starting' || !status?.message.startsWith("Couldn't connect"), status?.message + '\n' + app?.error);
      assert.ok(Date.now() < deadline, status?.message + '\n' + app?.error);
      await new Promise((done) => setTimeout(done, 500));
    }
    const status = (await client().extensions.list()).find((row) => row.id === 'engine-t3');
    assert.equal(status?.health?.ok, true);
    pid = status?.health?.pid;
    assert.ok(pid);
    assert.ok(Array.isArray((await client().x['engine-t3'].threads.list()).threads));
  }
  function confirmStopped(previousPid: number) {
    assert.throws(() => process.kill(previousPid, 0), { code: 'ESRCH' });
  }
  try {
    app = await gateway(temp, '', '', env);
    await client().extensions.enable({ id: 'engine-t3' });
    assert.equal((await client().x['engine-t3'].install.status()).state, 'not_installed');
    assert.equal((await client().x['engine-t3'].install.start()).state, 'installing');
    await confirmConnection(180_000);
    const firstPid = pid!;
    const runtimePath = join(temp, 'engines/t3-home/state/userdata/server-runtime.json');
    const { port: serverPort } = JSON.parse(readFileSync(runtimePath, 'utf8')) as { port: number };
    await streamsAcrossRenewal(root, installedT3(engines)!, serverPort, app, sessionTtl);
    await confirmConnection(5000);
    assert.equal(pid, firstPid, 'Session renewal keeps the T3 server alive');

    const executable = installedT3(engines)!;
    await probeProviderHomes(root, executable, serverPort, client(), forbiddenPath);
    await upgradeWhileConnected(temp, client(), firstPid);

    // A server that exits keeps its own reason in health, rather than a generic connection failure.
    await promisify(execFile)(system32('taskkill.exe'), ['/PID', String(firstPid), '/T', '/F'], { windowsHide: true });
    const exitDeadline = Date.now() + 10_000;
    const exitedReason = async () => (await client().extensions.list()).find((row) => row.id === 'engine-t3')?.health?.reason;
    while (!(await exitedReason())?.includes('server exited')) {
      assert.ok(Date.now() < exitDeadline, 'T3 exit reason: ' + await exitedReason());
      await new Promise((done) => setTimeout(done, 200));
    }
    await new Promise((done) => setTimeout(done, 4000));
    assert.match(await exitedReason() ?? '', /server exited/, 'the exit reason stays until Start');
    await client().x['engine-t3'].runtime.start();
    await confirmConnection(30_000);
    const restartedPid = pid!;
    assert.notEqual(restartedPid, firstPid);
    await client().extensions.disable({ id: 'engine-t3' });
    confirmStopped(restartedPid);
    const isolated = await isolatedT3Environment(root);
    const stalePort = await port();
    await stop(app.child, true);
    stale = spawn(executable, ['serve', '--mode', 'desktop', '--host', '127.0.0.1', '--port', String(stalePort),
      '--base-dir', isolated.T3CODE_HOME!, '--no-browser', '--bootstrap-fd', '0'], {
      cwd: root, env: isolated, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
    });
    stale.stdin!.end(JSON.stringify({
      mode: 'desktop', host: '127.0.0.1', noBrowser: true, port: stalePort, shellEnvironmentPrepared: true,
      desktopBootstrapToken: randomUUID(), tailscaleServeEnabled: false, tailscaleServePort: 443,
    }) + '\n');
    await waitForServer('http://127.0.0.1:' + stalePort, stale);
    // A marker whose Gateway PID is a live Neo Gateway blocks the start, with a specific reason.
    other = await gateway(await mkdtemp(join(temp, 'other-gateway-')), '', '', env);
    const markerPath = join(root, 'neo-runtime.json');
    await writeFile(markerPath, JSON.stringify({ pid: stale.pid, gatewayPid: other.child.pid, gatewayExecutable: process.execPath }));
    app = await gateway(temp, '', '', env);
    await client().extensions.enable({ id: 'engine-t3' });
    const ownedDeadline = Date.now() + 30_000;
    while (!(await exitedReason())?.includes('Another Neo Gateway')) {
      assert.ok(Date.now() < ownedDeadline, 'owned-elsewhere reason: ' + await exitedReason());
      await new Promise((done) => setTimeout(done, 300));
    }
    process.kill(stale.pid!, 0);
    // A reused PID that is not a Neo Gateway (this test process) leaves a stale marker, which is reclaimed.
    await stop(other.child, true);
    await writeFile(markerPath, JSON.stringify({ pid: stale.pid, gatewayPid: process.pid, gatewayExecutable: process.execPath }));
    await client().x['engine-t3'].runtime.start();
    await confirmConnection(30_000);
    assert.notEqual(pid, stale.pid);
    confirmStopped(stale.pid!);
    await stop(app.child, true);
    confirmStopped(pid!);
    const binary = readFileSync(executable);
    const resolver = binary.indexOf('resolveWindowsEnvironment =');
    assert.ok(resolver >= 0, 'Pinned release contains the Windows shell resolver');
    const embedded = binary.toString('utf8', resolver, resolver + 2400);
    const reads = [...embedded.matchAll(/readEnvironment\(\[([^\]]*)\], \{ loadProfile: (true|false) \}/g)]
      .map((match) => [...match[1].matchAll(/"([A-Z_]+)"/g)].map((key) => key[1]));
    assert.deepEqual(reads, [['PATH'], ['PATH', 'FNM_DIR', 'FNM_MULTISHELL_PATH']]);
    assert.ok(binary.includes('if (options?.shellEnvironmentPrepared === true) return;'));
    console.log('T3_RELEASE_BUNDLE PASS bootstrap_skip=true restored_keys=PATH,FNM_DIR,FNM_MULTISHELL_PATH');
    console.log('T3_REAL_INSTALL PASS download=github first_run=true renewal_past_expiry=true same_pid=true upgrade=same_server exit_reason=kept owned_elsewhere=reason reused_gateway_pid=reclaimed disable=stopped gateway_exit=stopped');
  } catch (error) {
    console.error('GATEWAY STDERR\n' + (app?.error ?? '').slice(-6000));
    throw error;
  } finally {
    const step = (name: string) => console.error('T3_CLEANUP ' + name);
    step('gateway'); await stop(app?.child, true);
    step('other-gateway'); await stop(other?.child, true);
    step('stale-server'); await stop(stale);
    // The kernel seals the upgraded generation read-only (managed-runtime.ts sealGeneration); fs.rm retries it forever.
    step('unseal'); await unsealFixtureTree(join(temp, 'extensions'));
    step('temp'); await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    step('done');
  }
}

try {
  if (process.env.NMH_TEST_T3_REAL_INSTALL === '1') await realInstall();
  else await main();
} finally {
  // esbuild's service child keeps the test process alive otherwise.
  await stopEsbuild();
  // The test must exit on its own. If anything still holds the event loop, name it and fail.
  setTimeout(() => {
    console.error('T3_TEST_OPEN_HANDLES ' + process.getActiveResourcesInfo().join(','));
    process.exit(1);
  }, 15_000).unref();
}
