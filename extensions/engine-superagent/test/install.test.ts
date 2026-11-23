// P7-16: an installed app has no dsh-superagent source. engine-superagent stays up with an install action;
// installing downloads the pinned source (here: a local fixture tarball of the pinned commit, no network), verifies
// it, builds the bundle Neo runs and reactivates engine-superagent. Scripted models, isolated homes, no credentials.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type SuperagentInstallStatus } from '@neometaharness/contracts';

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
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}${last ? ` (${String(last)})` : ''}`);
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

const cacheDir = join(extension, '.cache');
const appDataBundles = () => (existsSync(cacheDir) ? readdirSync(cacheDir) : [])
  .filter((name) => /^superagent-.+-app-data-[a-f0-9]{16}\.mjs$/.test(name)).map((name) => join(cacheDir, name));
// Bundles of an earlier run of this test belong to a deleted temp install.
for (const bundle of appDataBundles()) { rmSync(bundle, { force: true }); rmSync(bundle.replace(/\.mjs$/, '.built'), { force: true }); }
const temp = await mkdtemp(join(tmpdir(), 'nmh-superagent-install-'));
const data = join(temp, 'state');
// The desktop shell passes local app data (NMH_ENGINES_DIR), separate from the roaming data folder.
const engines = join(temp, 'local', 'engines');
let fixtureServer: Server | undefined;
const held: ServerResponse[] = [];
let app: Awaited<ReturnType<typeof startGateway>> | undefined;
try {
  // Fixture: the pinned commit as a GitHub-style tarball (pax comment = commit), with a lock pinned to its sha256.
  const lock = JSON.parse(readFileSync(join(repo, 'upstream.lock.json'), 'utf8'));
  const pin = lock.pins['dsh-superagent'];
  assert.match(pin.commit, /^[a-f0-9]{40}$/, 'the lock pins the full commit');
  assert.ok(pin.commit.startsWith(pin.ref), 'the pinned commit is the pinned ref');
  assert.match(pin.archive_sha256, /^[a-f0-9]{64}$/, 'the lock pins the archive sha256');
  const cache = join(devCache(), `dsh-superagent@${pin.ref}`);
  const fixture = execFileSync('git', ['-C', cache, 'archive', '--format=tar.gz', `--prefix=dsh-superagent-prototype-${pin.commit}/`, pin.commit],
    { maxBuffer: 256 * 1024 * 1024 });
  lock.pins['dsh-superagent'] = { ...pin, archive_sha256: createHash('sha256').update(fixture).digest('hex') };
  const lockFile = join(temp, 'upstream.lock.json');
  await writeFile(lockFile, JSON.stringify(lock, null, 2));

  let mode: 'unavailable' | 'corrupt' | 'hold' | 'good' = 'unavailable';
  let downloads = 0;
  fixtureServer = createServer((req, res) => {
    if (req.url !== `/${pin.upstream}/tar.gz/${pin.commit}`) { res.writeHead(404).end(); return; }
    downloads++;
    if (mode === 'unavailable') { res.writeHead(503).end(); return; }
    const body = mode === 'corrupt' ? Buffer.concat([fixture.subarray(0, 4096), Buffer.alloc(1024, 1)]) : fixture;
    res.writeHead(200, { 'content-type': 'application/x-gzip', 'content-length': body.length });
    if (mode === 'hold') { res.write(body.subarray(0, 64 * 1024)); held.push(res); return; } // stalls mid-download
    // Paced, so the download phase is observable.
    void (async () => {
      for (let offset = 0; offset < body.length; offset += 64 * 1024) {
        if (!res.write(body.subarray(offset, offset + 64 * 1024))) await new Promise((done) => res.once('drain', done));
        await sleep(40);
      }
      res.end();
    })();
  });
  await new Promise<void>((done) => fixtureServer!.listen(0, '127.0.0.1', done));

  const env = {
    NODE_ENV: 'test',
    NMH_TEST_UPSTREAM_LOCK: lockFile,
    NMH_TEST_ENGINE_DOWNLOAD_BASE: `http://127.0.0.1:${(fixtureServer.address() as { port: number }).port}`,
    NMH_UPSTREAM_CACHE: join(temp, 'no-dev-cache'),
    NMH_SUPERAGENT_TEST_ADAPTER: new URL('./scripted-models.ts', import.meta.url).href,
    NMH_DB_PATH: join(data, 'neo.sqlite'), NMH_ENGINES_DIR: engines, NMH_EXTENSIONS_DIR: join(repo, 'extensions'),
    NMH_PORT: '0', NEO_MODE: 'desktop', NEO_PRINT_DESKTOP_TOKEN: '1',
  };
  await mkdir(data, { recursive: true });
  app = await startGateway(env);
  const http = app.http;
  const row = async (id: string) => (await http.extensions.list()).find((item) => item.id === id)!;
  const status = () => http.x['engine-superagent'].install.status();
  const settle = (label: string) => eventually(async () => {
    const current = await status();
    return current.state !== 'installing' && current;
  }, label, 60000);

  assert.equal((await http.extensions.enable({ id: 'sample-ts' })).status, 'running');
  const enabled = await http.extensions.enable({ id: 'engine-superagent' });
  assert.equal(enabled.status, 'running', `engine-superagent stays up to offer the install: ${enabled.reason ?? app.stderr}`);
  assert.equal(enabled.health?.ok, true, 'not installed is not a fault');
  assert.deepEqual(await status(), { state: 'not_installed', message: 'The super agent is not installed yet.' });
  await assert.rejects(http.inbox.list(), /The super agent is not installed\. Install it from Extensions\./, 'no Inbox before the install, and the Gateway says why');
  await assert.rejects(http.inbox.ask({ text: 'Hi', botId: 'any' }), /not installed/);
  assert.equal((await row('engine-hermes')).status, 'disabled', 'the install does not need Hermes');

  // Network failure: plain-language reason, nothing left behind.
  assert.equal((await http.x['engine-superagent'].install.start()).state, 'installing');
  const offline = await settle('download failure') as SuperagentInstallStatus;
  assert.equal(offline.state, 'failed');
  assert.equal(offline.error, "Couldn't download the super agent. Check your internet connection and try again.");

  // A download that does not match the lock is refused.
  mode = 'corrupt';
  await http.x['engine-superagent'].install.start();
  const corrupt = await settle('verify failure') as SuperagentInstallStatus;
  assert.equal(corrupt.error, "The super agent download didn't match the version Neo expects, so it wasn't installed. Try again later.");
  assert.ok(!existsSync(join(engines, `dsh-superagent@${pin.ref}`)), 'nothing installed');
  assert.deepEqual(readdirSync(engines).filter((name) => name.startsWith('.tmp-')), [], 'temp files removed');

  // Disabling engine-superagent mid-install cancels it and leaves the rest healthy.
  mode = 'hold';
  await http.x['engine-superagent'].install.start();
  await eventually(async () => held.length > 0 && (await status()).phase === 'download', 'install is downloading', 30000);
  assert.equal((await http.extensions.disable({ id: 'engine-superagent' })).status, 'disabled');
  assert.equal((await row('sample-ts')).status, 'running');
  await eventually(async () => readdirSync(engines).every((name) => !name.startsWith('.tmp-')), 'cancelled install cleans up', 30000);
  assert.ok(!existsSync(join(engines, `dsh-superagent@${pin.ref}`)));
  for (const response of held.splice(0)) response.destroy();
  assert.equal((await http.extensions.enable({ id: 'engine-superagent' })).status, 'running');
  assert.equal((await status()).state, 'not_installed');

  // The install: progress through the phases, then engine-superagent comes back on its own with its Inbox.
  mode = 'good';
  const before = downloads;
  await http.x['engine-superagent'].install.start();
  const phases = new Set<string>();
  const ready = await eventually(async () => {
    const current = await status().catch(() => undefined); // routes are briefly absent while reactivating
    if (current?.phase) phases.add(current.phase);
    if (current?.state === 'failed') throw new Error(`install failed: ${current.error} ${app!.stderr}`);
    return current?.state === 'ready' && current;
  }, 'super agent installed and running', 120000);
  assert.equal(ready.state, 'ready');
  assert.equal(downloads - before, 1);
  assert.ok(phases.has('download'), `download phase reported (${[...phases]})`);
  const source = join(engines, `dsh-superagent@${pin.ref}`);
  assert.ok(existsSync(join(source, 'src/core/engine.ts')), 'source in the app data folder');
  assert.ok(existsSync(join(source, '.neo-engine.json')), 'install marker');
  const [bundle] = appDataBundles();
  assert.ok(bundle && existsSync(bundle.replace(/\.mjs$/, '.built')), 'bundle built from the installed source, with its sidecar');
  const builtAt = statSync(bundle).mtimeMs;
  const installed = await row('engine-superagent');
  assert.equal(installed.status, 'running');
  assert.equal(installed.health?.ok, true);

  // The pinned engine runs: an accepted ask becomes a ticket. Its worker hands the ticket to a Hermes bot, and
  // Hermes is not installed here, so the ticket ends without a result instead of hanging.
  const asked = await http.inbox.ask({ text: 'Summarise the open issues', botId: 'no-hermes-bot' });
  assert.equal(asked.status, 'suggestion');
  await http.inbox.accept({ id: asked.id });
  const done = await eventually(async () => {
    const item = (await http.inbox.list()).find((entry) => entry.id === asked.id);
    return item && item.ticketId && item.report && ['blocked', 'failed', 'ready'].includes(item.report.status) ? item : undefined;
  }, 'ticket reaches a final state', 60000);
  assert.ok(done.ticketId, 'the upstream Engine created a ticket');

  // After a restart the installed engine is used directly: no download, no install step.
  await stopGateway(app.child);
  app = await startGateway(env);
  assert.equal((await app.http.extensions.list()).find((item) => item.id === 'engine-superagent')?.status, 'running');
  assert.equal((await app.http.x['engine-superagent'].install.status()).state, 'ready');
  assert.ok((await app.http.inbox.list()).some((item) => item.id === asked.id), 'the Inbox survived the restart');
  assert.equal(downloads - before, 1, 'no second download');
  assert.ok(!existsSync(join(data, 'engines')), 'nothing installed into the roaming data folder');

  // Disabling the super agent leaves the rest healthy, and enabling it again starts it without a download.
  assert.equal((await app.http.extensions.disable({ id: 'engine-superagent' })).status, 'disabled');
  assert.equal((await app.http.extensions.list()).find((item) => item.id === 'sample-ts')?.status, 'running');
  assert.equal((await app.http.extensions.enable({ id: 'engine-superagent' })).status, 'running');
  assert.equal(downloads - before, 1);
  assert.deepEqual(appDataBundles(), [bundle], 'restarts and re-enables reuse the bundle');
  assert.equal(statSync(bundle).mtimeMs, builtAt, 'the bundle was not rebuilt');

  // A source whose bundle cannot be built (here: a file missing from the source and no bundle yet; on a real
  // machine e.g. esbuild quarantined) is offered again with a plain reason instead of a degraded card, and Try again
  // recovers once the cause is gone.
  await stopGateway(app.child);
  for (const name of readdirSync(cacheDir)) if (name.startsWith(`superagent-${pin.ref}-app-data-`)) rmSync(join(cacheDir, name));
  const moved = join(source, 'src/infra/health.ts');
  renameSync(moved, `${moved}.away`);
  app = await startGateway(env);
  const broken = await app.http.x['engine-superagent'].install.status();
  assert.deepEqual(broken, { state: 'failed', message: 'The super agent could not be prepared.',
    error: "Couldn't prepare the super agent. Try again; if it keeps failing, reinstall Neo." });
  const brokenRow = (await app.http.extensions.list()).find((item) => item.id === 'engine-superagent')!;
  assert.equal(brokenRow.status, 'running', 'install mode, not degraded');
  await assert.rejects(app.http.inbox.list(), /not installed/);
  renameSync(`${moved}.away`, moved);
  await app.http.x['engine-superagent'].install.start();
  await eventually(async () => {
    const current = await app!.http.x['engine-superagent'].install.status().catch(() => undefined);
    if (current?.state === 'failed') throw new Error(`retry failed: ${current.error} ${app!.stderr}`);
    return current?.state === 'ready';
  }, 'Try again rebuilds the bundle', 60000);
  assert.ok((await app.http.inbox.list()).some((item) => item.id === asked.id), 'the Inbox is back');
  assert.equal(downloads - before, 1, 'the retry did not download');
  assert.equal(appDataBundles().length, 1);

  console.log(`P7-16 SUPERAGENT INSTALL PASS not_installed=install-action network=plain-error verify=refused disable=cancel+healthy install=ready phases=${[...phases].join('>')} ticket=${done.report!.status} restart=reused bundle=reused toggle=healthy build_failure=retry`);
} finally {
  for (const response of held) response.destroy();
  await stopGateway(app?.child);
  await new Promise<void>((done) => fixtureServer ? fixtureServer.close(() => done()) : done());
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch((error) => console.error('cleanup', error));
}
