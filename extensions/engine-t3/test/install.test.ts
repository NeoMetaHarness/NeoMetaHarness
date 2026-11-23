import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T3Installer, installedT3 } from '../src/install.js';
import { isolatedT3Environment, T3LocalRuntime } from '../src/runtime.js';
import type { T3ControlPlane } from '../src/client.js';

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function eventually<T>(read: () => T | Promise<T>, test: (value: T) => boolean, label: string, timeout = 20000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (test(value)) return value;
    await sleep(80);
  }
  throw new Error('Timed out waiting for ' + label);
}
const temp = await mkdtemp(join(tmpdir(), 'neo-t3-install-fixture-'));
const engines = join(temp, 'engines');
const repository = join(temp, 'source');
const archiveBase = 't3-0.1.9-' + process.platform + '-' + process.arch;
const executable = process.platform === 'win32' ? 't3.exe' : 't3';
const releaseName = archiveBase + (process.platform === 'win32' ? '.zip' : '.tar.gz');
const oldEnv = { NODE_ENV: process.env.NODE_ENV, NMH_UPSTREAM_CACHE: process.env.NMH_UPSTREAM_CACHE,
  NMH_TEST_UPSTREAM_LOCK: process.env.NMH_TEST_UPSTREAM_LOCK, NMH_TEST_ENGINE_DOWNLOAD_BASE: process.env.NMH_TEST_ENGINE_DOWNLOAD_BASE,
  NMH_TEST_T3_ASSET_URL: process.env.NMH_TEST_T3_ASSET_URL };
let server: Server | undefined;
try {
  await mkdir(join(repository, 'apps/server/src'), { recursive: true });
  await writeFile(join(repository, 'apps/server/src/bin.ts'), 'export const fixture = true;\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.email', 'fixtures@example.invalid');
  git('config', 'user.name', 'T3 Fixture');
  git('add', '.');
  git('commit', '--quiet', '-m', 'Fixture');
  const commit = git('rev-parse', 'HEAD');
  const sourceArchive = execFileSync('git', ['-C', repository, 'archive', '--format=tar.gz',
    '--prefix=t3code-0.1.9/', commit], { maxBuffer: 8 * 1024 * 1024 });

  const artifact = join(temp, 'release');
  await mkdir(join(artifact, archiveBase), { recursive: true });
  await writeFile(join(artifact, archiveBase, executable), 'fixture executable\n');
  const cliPath = join(temp, releaseName);
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Compress-Archive -LiteralPath ' + JSON.stringify(join(artifact, archiveBase)) +
      ' -DestinationPath ' + JSON.stringify(cliPath)]);
  } else {
    execFileSync('tar', ['-czf', cliPath, '-C', artifact, archiveBase]);
  }
  const cliArchive = await readFile(cliPath);
  const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  const lock = join(temp, 'upstream.lock.json');
  await writeFile(lock, JSON.stringify({ schema_version: 1, pins: { t3code: {
    kind: 'release', ref: 'v0.1.9', upstream: 'pingdotgg/t3code', commit,
    archive_sha256: sha(sourceArchive), cli_assets: { [process.platform + '-' + process.arch]: sha(cliArchive) },
  } } }));
  let sourceBroken = true;
  let cliBroken = false;
  let sourceRequests = 0;
  let cliRequests = 0;
  server = createServer((req, res) => {
    if (req.url === '/pingdotgg/t3code/tar.gz/' + commit) {
      sourceRequests++;
      const body = sourceBroken ? Buffer.from('broken archive') : sourceArchive;
      res.writeHead(200, { 'content-length': body.length }).end(body);
    } else if (req.url === '/cli') {
      cliRequests++;
      const body = cliBroken ? Buffer.from('broken CLI') : cliArchive;
      res.writeHead(200, { 'content-length': body.length }).end(body);
    } else res.writeHead(404).end();
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  Object.assign(process.env, { NODE_ENV: 'test', NMH_UPSTREAM_CACHE: join(temp, 'missing-upstream-cache'),
    NMH_TEST_UPSTREAM_LOCK: lock, NMH_TEST_ENGINE_DOWNLOAD_BASE: url, NMH_TEST_T3_ASSET_URL: url + '/cli' });

  assert.equal(installedT3(engines), undefined);
  let activated = 0;
  const installer = new T3Installer(engines, () => { activated++; });
  assert.equal(installer.start().state, 'installing');
  let status = await eventually(() => installer.current(), (s) => s.state === 'failed', 'source checksum rejection');
  assert.match(status.error ?? '', /verification/);
  assert.equal(installedT3(engines), undefined);
  assert.equal(activated, 0);

  sourceBroken = false;
  cliBroken = true;
  installer.start();
  status = await eventually(() => installer.current(), (s) => s.state === 'failed', 'CLI checksum rejection');
  assert.match(status.error ?? '', /verification/);
  assert.equal(installedT3(engines), undefined);

  cliBroken = false;
  installer.start();
  status = await eventually(() => installer.current(), (s) => s.state === 'ready', 'installed T3');
  assert.equal(status.state, 'ready');
  assert.equal(activated, 1);
  const installed = installedT3(engines);
  assert.ok(installed?.endsWith(executable), 'verified CLI is present');
  assert.ok(existsSync(join(engines, 't3code@v0.1.9', '.neo-engine.json')), 'shared source installer produced its marker');
  assert.deepEqual(readdirSync(engines).filter((name) => name.startsWith('.tmp-') || name.endsWith('.tar.gz') || name.endsWith('.zip')), [],
    'temporary archives and partial installs are cleaned');
  assert.equal(sourceRequests, 3);
  assert.equal(cliRequests, 2);

  const repeat = new T3Installer(engines, () => { activated++; });
  repeat.start();
  await eventually(() => repeat.current(), (s) => s.state === 'ready', 'idempotent install');
  assert.equal(sourceRequests, 3, 'installed source reused');
  assert.equal(cliRequests, 2, 'installed server reused');

  const environment = await isolatedT3Environment(join(engines, 'isolated-env'), {
    PATH: process.env.PATH, NMH_T3_SCOPED_SESSION: 'owner-secret', OPENAI_API_KEY: 'owner-secret',
    T3CODE_HOME: 'owner-home', HOME: 'owner-home',
  });
  assert.equal(environment.NMH_T3_SCOPED_SESSION, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.ok(environment.HOME?.includes('isolated-env'));
  assert.ok(environment.T3CODE_HOME?.includes('isolated-env'));

  const fixtureCli = join(temp, 'fake-t3.cjs');
  await writeFile(fixtureCli, `
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const base = option('--base-dir');
fs.mkdirSync(base, { recursive: true });
if (args[0] === 'auth') {
  fs.writeFileSync(path.join(base, 'auth.json'), JSON.stringify({ scopes: args.filter((a) => a.includes(':')), home: process.env.HOME }));
  process.stdout.write('fixture-scoped-session-token\\n');
  process.exit(0);
}
if (args[0] !== 'serve') process.exit(3);
const host = option('--host');
const port = Number(option('--port'));
let probes = 0;
const server = http.createServer((request, response) => {
  if (request.url !== '/api/auth/websocket-ticket') return response.writeHead(404).end();
  if (request.headers.authorization !== 'Bearer fixture-scoped-session-token') return response.writeHead(401).end();
  probes++;
  if (probes === 1) return response.writeHead(503).end();
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ticket: 'fixture' }));
});
server.listen(port, host, () => {
  fs.writeFileSync(path.join(base, 'serve.json'), JSON.stringify({ host, port, pid: process.pid, home: process.env.HOME }));
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
  let connected = false;
  let disconnects = 0;
  let origin = '';
  const client = {
    get connected() { return connected; },
    connect: async (url: string, token: string) => {
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(token, 'fixture-scoped-session-token');
      origin = url;
      connected = true;
    },
    disconnect: async () => { connected = false; disconnects++; },
  } as unknown as T3ControlPlane;
  const runtime = new T3LocalRuntime(client, installed!, engines, { executable: process.execPath, prefix: [fixtureCli] });
  await Promise.all([runtime.start(), runtime.start()]);
  assert.equal(connected, true);
  assert.equal(runtime.reason, '');
  const state = join(engines, 't3-home/state');
  const launched = JSON.parse(readFileSync(join(state, 'serve.json'), 'utf8')) as { host: string; port: number; pid: number; home: string };
  const issued = JSON.parse(readFileSync(join(state, 'auth.json'), 'utf8')) as { scopes: string[]; home: string };
  assert.equal(launched.host, '127.0.0.1');
  assert.equal(origin, 'http://127.0.0.1:' + launched.port);
  assert.equal(issued.home, launched.home);
  assert.deepEqual(issued.scopes, ['orchestration:read', 'orchestration:operate', 'providers:manage']);
  assert.ok(launched.home.includes('t3-home'));
  await runtime.stop();
  assert.equal(connected, false);
  assert.ok(disconnects >= 1);
  assert.rejects(runtime.start(), /disabled/);
  await eventually(() => {
    try { process.kill(launched.pid, 0); return false; } catch { return true; }
  }, Boolean, 'server process stops');

  console.log('T3_INSTALL PASS checksum_source=true checksum_cli=true shared_source=true idempotent=true');
  console.log('T3_RUNTIME PASS loopback=true isolated_home=true scoped_session=true reconnect=false stop=true');
} finally {
  if (server) await new Promise<void>((done) => server!.close(() => done()));
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
