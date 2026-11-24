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
const archiveBase = 't3-0.1.9-' + process.platform + '-' + process.arch;
const executable = process.platform === 'win32' ? 't3.exe' : 't3';
const releaseName = archiveBase + (process.platform === 'win32' ? '.zip' : '.tar.gz');
const oldEnv = { NODE_ENV: process.env.NODE_ENV, NMH_TEST_UPSTREAM_LOCK: process.env.NMH_TEST_UPSTREAM_LOCK,
  NMH_TEST_T3_ASSET_URL: process.env.NMH_TEST_T3_ASSET_URL };
let server: Server | undefined;
let runtime: T3LocalRuntime | undefined;
const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });
try {
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
  const pinArchive = (body: Buffer) => writeFile(lock, JSON.stringify({ schema_version: 1, pins: { t3code: {
    kind: 'release', ref: 'v0.1.9', upstream: 'pingdotgg/t3code', commit: '0'.repeat(40),
    cli_assets: { [process.platform + '-' + process.arch]: sha(body) },
  } } }));
  await pinArchive(cliArchive);
  let download = Buffer.from('wrong checksum');
  let requests = 0;
  server = createServer((req, res) => {
    if (req.url !== '/cli') return res.writeHead(404).end();
    requests++;
    res.writeHead(200, { 'content-length': download.length }).end(download);
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  Object.assign(process.env, { NODE_ENV: 'test', NMH_TEST_UPSTREAM_LOCK: lock, NMH_TEST_T3_ASSET_URL: url + '/cli' });

  assert.equal(installedT3(engines), undefined);
  await mkdir(join(engines, '.tmp-t3-cli-interrupted'), { recursive: true });
  let activated = 0;
  const installer = new T3Installer(engines, () => { activated++; });
  async function rejected() {
    assert.equal(installer.start().state, 'installing');
    const status = await eventually(() => installer.current(), (s) => s.state === 'failed', 'archive rejection');
    assert.match(status.error ?? '', /verification/);
    assert.equal(installedT3(engines), undefined);
    assert.equal(activated, 0);
    assert.deepEqual(readdirSync(engines), [], 'temporary files and partial installs are cleaned');
  }
  await rejected();

  // A minimal USTAR header lets archived links and unsafe paths be tested on any OS.
  function entry(name: string, type: string, target = '') {
    const header = Buffer.alloc(512);
    header.write(name);
    header.write('0000755\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write('00000000000\0', 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write(target, 157);
    header.write('ustar\0' + '00', 257);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    return header;
  }
  for (const bad of [
    entry(archiveBase + '/link', '2', 'file'),
    entry(archiveBase + '/hardlink', '1', archiveBase + '/file'),
    entry(archiveBase + '/fifo', '6'),
    entry(archiveBase + '/../outside', '0'),
    entry('/absolute', '0'),
    entry(archiveBase + '/NUL.txt', '0'),
  ]) {
    download = Buffer.concat([entry(archiveBase + '/' + executable, '0'), bad, Buffer.alloc(1024)]);
    await pinArchive(download);
    await rejected();
  }
  download = Buffer.from(cliArchive);
  await pinArchive(cliArchive);
  installer.start();
  await eventually(() => installer.current(), (s) => s.state === 'ready', 'installed T3');
  assert.equal(activated, 1);
  const installed = installedT3(engines);
  assert.ok(installed?.endsWith(executable), 'verified CLI is present');

  const beforeRepeat = requests;
  const repeat = new T3Installer(engines, () => { activated++; });
  repeat.start();
  await eventually(() => repeat.current(), (s) => s.state === 'ready', 'idempotent install');
  assert.equal(requests, beforeRepeat, 'installed server reused');

  const environment = await isolatedT3Environment(join(engines, 'isolated-env'), {
    PATH: process.env.PATH, NMH_T3_SCOPED_SESSION: 'owner-secret', OPENAI_API_KEY: 'owner-secret',
    T3CODE_HOME: 'owner-home', HOME: 'owner-home', CODEX_HOME: 'owner-codex', CLAUDE_CONFIG_DIR: 'owner-claude',
  });
  assert.equal(environment.NMH_T3_SCOPED_SESSION, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.ok(environment.HOME?.includes('isolated-env'));
  assert.ok(environment.T3CODE_HOME?.includes('isolated-env'));
  assert.equal(environment.CODEX_HOME, join(engines, 'isolated-env/codex'));
  assert.equal(environment.CLAUDE_CONFIG_DIR, join(engines, 'isolated-env/claude'));

  const providerHomes = {
    CODEX_HOME: ['codex'], CLAUDE_CONFIG_DIR: ['claude'], CLAUDE_CODE_PLUGIN_CACHE_DIR: ['claude', 'plugins'],
    GEMINI_HOME: ['gemini'], ANTIGRAVITY_DATA_DIR: ['antigravity'], GROK_HOME: ['grok'],
    OPENCODE_DATA_DIR: ['data', 'opencode'],
  };
  const fixtureCli = join(temp, 'fake-t3.cjs');
  const fixtureScript = `
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const base = option('--base-dir');
fs.mkdirSync(base, { recursive: true });
if (args[0] === 'auth') {
  if (!fs.existsSync(path.join(base, 'ready'))) process.exit(4);
  // T3 v0.1.9 apps/server/src/cliAuthFormat.ts:107-131: --json prints sessionId and token. revoke takes the id.
  if (args[2] === 'revoke') {
    fs.appendFileSync(path.join(base, 'revoked.txt'), args[args.length - 1] + '\\n');
    process.exit(0);
  }
  if (fs.existsSync(path.join(base, 'issue-broken'))) { process.stdout.write('not json\\n'); process.exit(0); }
  fs.writeFileSync(path.join(base, 'auth.json'), JSON.stringify({ scopes: args.filter((a) => /^(orchestration|providers|terminal):/.test(a)), home: process.env.HOME }));
  const crypto = require('node:crypto');
  process.stdout.write(JSON.stringify({ sessionId: crypto.randomUUID(), token: crypto.randomUUID() }) + '\\n');
  process.exit(0);
}
if (args[0] !== 'serve') process.exit(3);
const host = option('--host');
const port = Number(option('--port'));
const bootstrap = JSON.parse(fs.readFileSync(0, 'utf8'));
if (!bootstrap.shellEnvironmentPrepared) process.exit(5);
const providerHomeKeys = ${JSON.stringify(Object.keys(providerHomes))};
fs.writeFileSync(path.join(base, 'child-env.json'), JSON.stringify(
  Object.fromEntries(providerHomeKeys.map((key) => [key, process.env[key]]))
));
const server = http.createServer((request, response) => {
  if (request.url !== '/api/auth/websocket-ticket') return response.writeHead(404).end();
  if (request.headers.authorization) return response.writeHead(400).end();
  fs.writeFileSync(path.join(base, 'ready'), '');
  response.writeHead(401).end();
});
server.listen(port, host, () => {
  const userdata = path.join(base, 'userdata');
  fs.mkdirSync(userdata, { recursive: true });
  fs.writeFileSync(path.join(userdata, 'server-runtime.json'), JSON.stringify({
    port, origin: 'http://' + host + ':' + port, pid: process.pid, startedAt: new Date().toISOString(), home: process.env.HOME,
  }));
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;
  let connected = false;
  let disconnects = 0;
  let origin = '';
  const tokens = new Set<string>();
  let remoteClose: (() => void) | undefined;
  const client = {
    get connected() { return connected; },
    connect: async (url: string, token: string, _signal: AbortSignal, onClose: () => void) => {
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.ok(!tokens.has(token));
      tokens.add(token);
      remoteClose = () => { connected = false; onClose(); };
      origin = url;
      connected = true;
    },
    disconnect: async () => { connected = false; disconnects++; },
  } as unknown as T3ControlPlane;
  runtime = new T3LocalRuntime(client, installed!, engines, { executable: process.execPath, prefix: [fixtureCli], sessionTtlMs: 1500 });
  await assert.rejects(runtime.start());
  assert.match(runtime.reason, /choose Start to try again/i);
  assert.equal(connected, false);
  await writeFile(fixtureCli, fixtureScript);
  await Promise.all([runtime.start(), runtime.start()]);
  assert.equal(connected, true);
  assert.equal(runtime.reason, '');
  const state = join(engines, 't3-home/state');
  const launched = JSON.parse(readFileSync(join(state, 'userdata/server-runtime.json'), 'utf8')) as { port: number; pid: number; home: string };
  const issued = JSON.parse(readFileSync(join(state, 'auth.json'), 'utf8')) as { scopes: string[]; home: string };
  assert.equal(origin, 'http://127.0.0.1:' + launched.port);
  assert.equal(issued.home, launched.home);
  assert.deepEqual(issued.scopes, ['orchestration:read', 'orchestration:operate', 'providers:manage', 'terminal:read', 'terminal:operate']);
  assert.ok(launched.home.includes('t3-home'));
  const actualChildHomes = JSON.parse(await readFile(join(state, 'child-env.json'), 'utf8'));
  for (const [key, folders] of Object.entries(providerHomes)) {
    assert.equal(actualChildHomes[key], join(engines, 't3-home', ...folders), key);
  }
  await eventually(() => tokens.size, (count) => count >= 2, 'proactive renewal');
  assert.equal(runtime.pid, launched.pid);
  const revokedPath = join(state, 'revoked.txt');
  await eventually(() => existsSync(revokedPath) ? readFileSync(revokedPath, 'utf8').trim().split('\n').length : 0,
    (count) => count >= 1, 'previous session revoked after renewal');
  // A failed renewal becomes a handled reason. The server and the serving connection stay up.
  await writeFile(join(state, 'issue-broken'), '');
  await eventually(() => runtime!.reason, (reason) => /choose Start to try again/i.test(reason), 'failed renewal reason');
  assert.equal(connected, true);
  assert.equal(runtime.pid, launched.pid);
  await rm(join(state, 'issue-broken'));
  await eventually(() => runtime!.reason, (reason) => reason === '', 'renewal recovers');
  const issuedBeforeClose = tokens.size;
  remoteClose!();
  await eventually(() => tokens.size, (count) => count > issuedBeforeClose, 'renewal after socket close');
  assert.equal(runtime.pid, launched.pid);
  await runtime.stop();
  assert.equal(connected, false);
  assert.ok(disconnects >= 1);
  await assert.rejects(runtime.start(), /disabled/);
  await eventually(() => {
    try { process.kill(launched.pid, 0); return false; } catch { return true; }
  }, Boolean, 'server process stops');

  console.log('T3_INSTALL PASS checksum=true unsafe_entries=6 idempotent=true');
  assert.deepEqual(unhandled, [], 'no connect failure escapes as an unhandled rejection');
  console.log('T3_RUNTIME PASS loopback=true isolated_home=true first_run=true child_homes=isolated scoped_session=true proactive_renewal=true socket_close_reconnect=true same_pid=true revoke=true failed_renewal=handled unhandled=0 stop=true');
} finally {
  await runtime?.stop();
  if (server) await new Promise<void>((done) => server!.close(() => done()));
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
