import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { WebSocket } from 'ws';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type T3Event } from '@neometaharness/contracts';
import { build } from 'esbuild';
import { isolatedT3Environment } from '../src/runtime.js';
import { coalesceText } from '../../../apps/gateway/src/coalesce.js';

const here = fileURLToPath(new URL('../', import.meta.url));
const repo = resolve(here, '../..');
const spike = join(repo, 'spikes/P0-3a-t3-headless-client');
const t3Ref = (JSON.parse(readFileSync(join(repo, 'upstream.lock.json'), 'utf8')) as { pins: Record<string, { ref: string }> }).pins.t3code!.ref;
const cacheRoot = process.env.NMH_UPSTREAM_CACHE;
assert.ok(cacheRoot, 'Set NMH_UPSTREAM_CACHE to the pinned upstream source cache for the T3 wire tests');
const upstream = join(cacheRoot, `t3code@${t3Ref}`);
const gatewayDir = join(repo, 'apps/gateway');
const pinnedSha = '24e77473ecf41bc1f7142529c7911c1c1aae1d76';
const localAppData = process.env.LOCALAPPDATA;
assert.ok(localAppData, 'T3 test requires installed desktop T3 CLI on Windows');
const electron = join(localAppData, 'Programs/t3code/T3 Code (Beta).exe');
const t3Entry = join(localAppData, 'Programs/t3code/resources/server.asar/apps/server/dist/bin.mjs');
type Client = ContractRouterClient<typeof neoContract>;

async function port(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done) => listener.close(() => done()));
  return address.port;
}

function t3(args: string[], env: NodeJS.ProcessEnv, cwd: string): ChildProcess {
  const cli = process.env.NMH_TEST_T3_CLI;
  return spawn(cli || electron, cli ? args : [t3Entry, ...args], { cwd,
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: cli ? env : { ...env, ELECTRON_RUN_AS_NODE: '1', T3CODE_DESKTOP_CLI_LAUNCHER: '1' },
  });
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

async function gateway(state: string, url = '', session = '') {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: gatewayDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NMH_DB_PATH: join(state, 'neo.sqlite'), NMH_EXTENSIONS_DIR: join(repo, 'extensions'),
      NMH_PORT: '0', NMH_ENGINES_DIR: join(state, 'engines'), NMH_T3_URL: url, NMH_T3_SCOPED_SESSION: session, NEO_MODE: 'desktop', NEO_PRINT_DESKTOP_TOKEN: '1' },
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

function connectedT3Sockets(serverPort: number, gatewayPid: number): number {
  const output = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
  return output.split(/\r?\n/).filter((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[0] === 'TCP' && fields[2] === `127.0.0.1:${serverPort}` &&
      fields[3] === 'ESTABLISHED' && Number(fields[4]) === gatewayPid;
  }).length;
}

async function main() {
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
  assert.equal(execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), pinnedSha);
  const temp = await mkdtemp(join(tmpdir(), 'nmh-t3-isolated-'));
  const cache = join(here, 'test/.cache');
  let server: ChildProcess | undefined;
  let app: Awaited<ReturnType<typeof gateway>> | undefined;
  let socket: WebSocket | undefined;
  try {
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
    const isolatedPort = await port();
    const url = `http://127.0.0.1:${isolatedPort}`;
    const environment = await isolatedT3Environment(temp);
    const state = environment.T3CODE_HOME!;
    server = t3(['serve', '--mode', 'desktop', '--host', '127.0.0.1', '--port', String(isolatedPort),
      '--base-dir', state, '--no-browser'], environment, temp);
    await waitForServer(url, server);
    const session = await capture(t3(['auth', 'session', 'issue', '--base-dir', state,
      '--scope', 'orchestration:read', '--scope', 'orchestration:operate',
      '--scope', 'providers:manage', '--ttl', '15m', '--label', 'nmh-isolated-test', '--token-only'], environment, temp));
    assert.ok(session.length > 16, 'isolated session token was not issued');
    const projectId = randomUUID();
    const providerId = 'nmhFakeAcp';
    const setup = spawn(process.execPath, [bundle], {
      cwd: here, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, T3_TEST_URL: url, T3_TEST_SESSION: session,
        T3_TEST_PROVIDER: providerId, T3_TEST_PROJECT: projectId,
        T3_TEST_WORKSPACE: join(temp, 'workspace'), T3_TEST_FAKE_ACP: join(spike, 'fake-acp.mjs') },
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
    console.log(`T3_GATEWAY_E2E PASS ordered=${sequences.length} chunks=${text.length} approvals=declined settled=true socket=closed disable=404 sample=healthy`);
  } finally {
    socket?.close();
    await stop(app?.child, true);
    await stop(server);
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

// Opt-in smoke for the real release, from a clean installed-app data layout.
async function realInstall() {
  const temp = await mkdtemp(join(tmpdir(), 'nmh-t3-real-release-'));
  let app: Awaited<ReturnType<typeof gateway>> | undefined;
  let pid: number | undefined;
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
      assert.ok(Date.now() < deadline, status?.message + '\n' + app?.error);
      await new Promise((done) => setTimeout(done, 500));
    }
    const status = (await client().extensions.list()).find((row) => row.id === 'engine-t3');
    assert.equal(status?.health?.ok, true);
    pid = status?.health?.pid;
    assert.ok(pid);
    assert.deepEqual(await client().x['engine-t3'].threads.list(), { projects: [], threads: [] });
  }
  function confirmStopped(previousPid: number) {
    assert.throws(() => process.kill(previousPid, 0), { code: 'ESRCH' });
  }
  try {
    app = await gateway(temp);
    await client().extensions.enable({ id: 'engine-t3' });
    assert.equal((await client().x['engine-t3'].install.status()).state, 'not_installed');
    assert.equal((await client().x['engine-t3'].install.start()).state, 'installing');
    await confirmConnection(180_000);
    await client().extensions.disable({ id: 'engine-t3' });
    confirmStopped(pid!);

    await client().extensions.enable({ id: 'engine-t3' });
    await confirmConnection(30_000);
    await stop(app.child, true);
    confirmStopped(pid!);
    console.log('T3_REAL_INSTALL PASS download=github lock=verified coding=connected disable=stopped gateway_exit=stopped');
  } finally {
    await stop(app?.child, true);
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

if (process.env.NMH_TEST_T3_REAL_INSTALL === '1') await realInstall();
else await main();
