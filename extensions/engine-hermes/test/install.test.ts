// P7-16: an installed app has no Hermes source or venv. engine-hermes stays up with an install action; installing
// downloads the pinned source (here: a local fixture tarball of the pinned commit, no network for the download),
// verifies it, prepares the venv in the app data folder and reactivates engine-hermes and channels.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import { WebSocket } from 'ws';
import { neoContract, type HermesInstallStatus } from '@neometaharness/contracts';

type Client = ContractRouterClient<typeof neoContract>;
const extension = fileURLToPath(new URL('../', import.meta.url));
const repo = resolve(extension, '../..');
const gatewayDir = join(repo, 'apps/gateway');
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function devCache(): string {
  if (process.env.NMH_UPSTREAM_CACHE) return process.env.NMH_UPSTREAM_CACHE;
  for (let dir = repo; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'nmh-upstream-cache'))) return join(dir, 'nmh-upstream-cache');
    if (dirname(dir) === dir) throw new Error('The fixture is built from the development upstream cache (set NMH_UPSTREAM_CACHE)');
  }
}

async function eventually<T>(check: () => Promise<T | undefined | false>, label: string, ms: number): Promise<T> {
  const until = Date.now() + ms;
  let last: unknown;
  while (Date.now() < until) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await sleep(250);
  }
  throw new Error(`Timed out: ${label}${last ? ` (${String(last)})` : ''}`);
}

async function fakeModel(): Promise<Server> {
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
      return;
    }
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const delta of [{ role: 'assistant', content: '' }, { content: 'Hello after install.' }]) {
      res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    }
    res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return server;
}

async function startGateway(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: gatewayDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, ...env },
  });
  let stderr = '';
  child.stderr!.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-8000); });
  let token = '';
  const port = await new Promise<number>((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Gateway startup timed out ' + stderr)), 60000);
    const reader = createInterface({ input: child.stdout! });
    reader.on('line', (line) => {
      if (line.startsWith('NEO_DESKTOP_TOKEN ')) token = line.slice(18).trim();
      if (line.startsWith('GATEWAY_READY ')) { clearTimeout(timer); reader.close(); done((JSON.parse(line.slice(14)) as { port: number }).port); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Gateway exited ' + code + ' ' + stderr)); });
  });
  const http = createORPCClient<Client>(new HttpLink({ url: `http://127.0.0.1:${port}`, headers: () => ({ authorization: `Bearer ${token}` }) }));
  return { child, port, token, http, get stderr() { return stderr; } };
}

async function stopGateway(child?: ChildProcess) {
  if (!child || child.exitCode !== null) return;
  if (child.connected) child.send('shutdown');
  const exited = await Promise.race([new Promise<boolean>((done) => child.once('exit', () => done(true))), sleep(30000).then(() => false)]);
  if (!exited) child.kill('SIGKILL');
}

const temp = await mkdtemp(join(tmpdir(), 'nmh-hermes-install-'));
const data = join(temp, 'state');
// The desktop shell passes local app data (NMH_ENGINES_DIR), separate from the roaming data folder.
const engines = join(temp, 'local', 'engines');
let fixtureServer: Server | undefined;
let model: Server | undefined;
let app: Awaited<ReturnType<typeof startGateway>> | undefined;
try {
  // Fixture: the pinned commit as a GitHub-style tarball (pax comment = commit), with a lock pinned to its sha256.
  const lock = JSON.parse(readFileSync(join(repo, 'upstream.lock.json'), 'utf8'));
  const pin = lock.pins['hermes-agent'];
  const cache = join(devCache(), `hermes-agent@${pin.ref}`);
  const fixture = execFileSync('git', ['-C', cache, 'archive', '--format=tar.gz', `--prefix=hermes-agent-${pin.ref.replace(/^v/, '')}/`, pin.commit],
    { maxBuffer: 512 * 1024 * 1024 });
  lock.pins['hermes-agent'] = { ...pin, archive_sha256: createHash('sha256').update(fixture).digest('hex') };
  const lockFile = join(temp, 'upstream.lock.json');
  await writeFile(lockFile, JSON.stringify(lock, null, 2));

  let mode: 'unavailable' | 'corrupt' | 'good' = 'unavailable';
  let downloads = 0;
  fixtureServer = createServer((req, res) => {
    if (req.url !== `/${pin.upstream}/tar.gz/${pin.commit}`) { res.writeHead(404).end(); return; }
    downloads++;
    if (mode === 'unavailable') { res.writeHead(503).end(); return; }
    const body = mode === 'corrupt' ? Buffer.concat([fixture.subarray(0, 4096), Buffer.alloc(1024, 1)]) : fixture;
    res.writeHead(200, { 'content-type': 'application/x-gzip', 'content-length': body.length }).end(body);
  });
  await new Promise<void>((done) => fixtureServer!.listen(0, '127.0.0.1', done));
  model = await fakeModel();

  // venv: the shared uv cache of this checkout and the user's uv-managed Pythons (both only read when warm).
  const uvPython = execFileSync('uv', ['python', 'dir'], { encoding: 'utf8' }).trim();
  const env = {
    NODE_ENV: 'test',
    NMH_TEST_UPSTREAM_LOCK: lockFile,
    NMH_TEST_ENGINE_DOWNLOAD_BASE: `http://127.0.0.1:${(fixtureServer.address() as { port: number }).port}`,
    NMH_UPSTREAM_CACHE: join(temp, 'no-dev-cache'),
    UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? join(extension, '.cache', 'uv-cache'),
    UV_PYTHON_INSTALL_DIR: process.env.UV_PYTHON_INSTALL_DIR ?? uvPython,
    NMH_HERMES_MODEL_URL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
    NMH_DB_PATH: join(data, 'neo.sqlite'), NMH_ENGINES_DIR: engines, NMH_EXTENSIONS_DIR: join(repo, 'extensions'),
    NMH_PORT: '0', NEO_MODE: 'desktop', NEO_PRINT_DESKTOP_TOKEN: '1',
  };
  await mkdir(data, { recursive: true });
  app = await startGateway(env);
  const http = app.http;
  const row = async (id: string) => (await http.extensions.list()).find((item) => item.id === id)!;
  const status = () => http.x['engine-hermes'].install.status();
  const settle = (label: string) => eventually(async () => {
    const current = await status();
    return current.state !== 'installing' && current;
  }, label, 120000);

  assert.equal((await http.extensions.enable({ id: 'sample-ts' })).status, 'running');
  const enabled = await http.extensions.enable({ id: 'engine-hermes' });
  assert.equal(enabled.status, 'running', 'engine-hermes stays up to offer the install');
  assert.equal(enabled.health?.ok, true, 'not installed is not a fault');
  assert.deepEqual(await status(), { state: 'not_installed', message: 'Hermes is not installed yet.' });
  const channels = await http.extensions.enable({ id: 'channels' });
  assert.equal(channels.status, 'degraded', 'channels needs Hermes');
  await assert.rejects(http.x['engine-hermes'].profiles.list(), 'no Hermes routes before the install');

  // Network failure: plain-language reason, nothing left behind.
  assert.equal((await http.x['engine-hermes'].install.start()).state, 'installing');
  const offline = await settle('download failure') as HermesInstallStatus;
  assert.equal(offline.state, 'failed');
  assert.equal(offline.error, "Couldn't download Hermes. Check your internet connection and try again.");

  // A download that does not match the lock is refused.
  mode = 'corrupt';
  await http.x['engine-hermes'].install.start();
  const corrupt = await settle('verify failure') as HermesInstallStatus;
  assert.equal(corrupt.error, "The Hermes download didn't match the version Neo expects, so it wasn't installed. Try again later.");
  assert.ok(!existsSync(join(engines, `hermes-agent@${pin.ref}`)), 'nothing installed');
  assert.deepEqual(readdirSync(engines).filter((name) => name.startsWith('.tmp-')), [], 'temp files removed');

  // Disabling engine-hermes mid-install cancels it and leaves the rest healthy.
  mode = 'good';
  await http.x['engine-hermes'].install.start();
  await eventually(async () => (await status()).phase === 'extract', 'install reaches extraction', 60000);
  assert.equal((await http.extensions.disable({ id: 'engine-hermes' })).status, 'disabled');
  assert.equal((await row('sample-ts')).status, 'running');
  assert.equal((await row('channels')).status, 'degraded');
  await eventually(async () => readdirSync(engines).every((name) => !name.startsWith('.tmp-')), 'cancelled install cleans up', 30000);
  assert.ok(!existsSync(join(engines, `hermes-agent@${pin.ref}`)));
  assert.equal((await http.extensions.enable({ id: 'engine-hermes' })).status, 'running');
  assert.equal((await status()).state, 'not_installed');

  // The install: progress through the phases, then engine-hermes and channels come back on their own.
  const before = downloads;
  await http.x['engine-hermes'].install.start();
  const phases = new Set<string>();
  const ready = await eventually(async () => {
    const current = await status().catch(() => undefined); // routes are briefly absent while reactivating
    if (current?.phase) phases.add(current.phase);
    if (current?.state === 'failed') throw new Error(`install failed: ${current.error} ${app!.stderr}`);
    return current?.state === 'ready' && current;
  }, 'Hermes installed and running', 900000);
  assert.equal(ready.state, 'ready');
  assert.equal(downloads - before, 1);
  for (const phase of ['download', 'extract', 'dependencies']) assert.ok(phases.has(phase), `phase ${phase} reported (${[...phases]})`);
  const source = join(engines, `hermes-agent@${pin.ref}`);
  assert.ok(existsSync(join(source, 'gateway/platforms/api_server.py')), 'source in the app data folder');
  assert.ok(existsSync(join(source, '.neo-engine.json')), 'install marker');
  assert.ok(existsSync(join(engines, 'venvs', `hermes-agent@${pin.ref}`, '.neo-hermes-upstream')), 'venv in the app data folder');
  assert.equal((await row('engine-hermes')).health?.ok, true);
  await eventually(async () => (await row('channels')).status === 'running', 'channels recovers', 60000);

  // Onboarding's bot step and first reply now work.
  const created = await http.x['engine-hermes'].profiles.create({ name: 'first-bot' });
  assert.equal(created.name, 'first-bot');
  assert.ok(existsSync(join(data, 'extensions', 'engine-hermes', 'home', 'profiles', 'first-bot')), 'Hermes home in the app data folder');
  const run = await http.x['engine-hermes'].runs.start({ profile: 'first-bot', input: 'Hi' });
  const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, ['bearer.' + app.token]);
  const ws = createORPCClient<Client>(new WebSocketLink({ websocket: socket as unknown as globalThis.WebSocket }));
  let text = '';
  for await (const event of await ws.x['engine-hermes'].runs.events({ profile: 'first-bot', runId: run.run_id })) {
    if (event.kind === 'text.delta') text += event.textDelta ?? '';
    if (event.type === 'run.completed' || event.type === 'run.failed') break;
  }
  socket.close();
  assert.match(text, /Hello after install\./);

  // After a restart the installed engine is used directly: no download, no install step.
  await stopGateway(app.child);
  app = await startGateway(env);
  assert.equal((await app.http.extensions.list()).find((item) => item.id === 'engine-hermes')?.status, 'running');
  assert.equal((await app.http.x['engine-hermes'].install.status()).state, 'ready');
  assert.ok((await app.http.x['engine-hermes'].profiles.list()).profiles.some((profile) => profile.name === 'first-bot'));
  assert.equal(downloads - before, 1, 'no second download');
  assert.ok(!existsSync(join(data, 'engines')), 'nothing installed into the roaming data folder');

  // A venv whose base Python disappeared is detected by running it: install mode again, and the install rebuilds
  // the venv from the installed source without downloading.
  await stopGateway(app.child);
  // uv's Windows launcher embeds the base interpreter path (pyvenv.cfg `home` is not read), so stand in for a removed
  // base Python with a venv python that cannot run. Remove first: on POSIX it is a symlink to the shared Python.
  const venvPython = join(engines, 'venvs', `hermes-agent@${pin.ref}`, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  await rm(venvPython, { force: true });
  await writeFile(venvPython, 'not a program', { mode: 0o755 });
  app = await startGateway(env);
  const broken = app.http;
  const brokenStatus = await eventually(async () => broken.x['engine-hermes'].install.status().catch(async (error) => {
    throw new Error(`${String(error)} row=${JSON.stringify((await broken.extensions.list()).find((item) => item.id === 'engine-hermes'))}`);
  }), 'engine-hermes back in install mode', 60000);
  assert.equal(brokenStatus.state, 'not_installed', 'a broken venv is not ready');
  await broken.x['engine-hermes'].install.start();
  await eventually(async () => {
    const current = await broken.x['engine-hermes'].install.status().catch(() => undefined);
    if (current?.state === 'failed') throw new Error(`repair failed: ${current.error} ${app!.stderr}`);
    return current?.state === 'ready';
  }, 'broken venv rebuilt', 600000);
  assert.ok((await broken.x['engine-hermes'].profiles.list()).profiles.some((profile) => profile.name === 'first-bot'));
  assert.equal(downloads - before, 1, 'the repair did not download again');

  console.log('P7-16 HERMES INSTALL PASS not_installed=install-action network=plain-error verify=refused disable=cancel+healthy install=ready channels=recovered bot=created reply=ok restart=reused broken_venv=rebuilt');
} finally {
  await stopGateway(app?.child);
  await new Promise<void>((done) => fixtureServer ? fixtureServer.close(() => done()) : done());
  await new Promise<void>((done) => model ? model.close(() => done()) : done());
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch((error) => console.error('cleanup', error));
}
