// P7-16: the shared engine-source resolver/installer against local fixture tarballs (no network).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { EngineInstallError, engineDownloadUrl, installEngineSource, resolveEngineSource, safeEntryPath } from '../src/engine-source.js';

const COMMIT = 'ae2a81ccc00e9b7c06301523e5bb09608397149c';

type Entry = { name: string; type?: string; body?: string; link?: string };
function header(name: string, type: string, size: number, link = ''): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 'latin1');
  block.write('0000000\0', 108, 'latin1'); block.write('0000000\0', 116, 'latin1');
  block.write(size.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
  block.write('00000000000\0', 136, 'latin1');
  block.write('        ', 148, 'latin1');
  block.write(type, 156, 'latin1');
  block.write(link, 157, 100, 'utf8');
  block.write('ustar\0', 257, 'latin1'); block.write('00', 263, 'latin1');
  let sum = 0; for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return block;
}
function padded(body: Buffer): Buffer { return Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]); }
function paxRecord(key: string, value: string): string {
  const text = ` ${key}=${value}\n`;
  let length = text.length + 1;
  while (String(length).length + text.length !== length) length = String(length).length + text.length;
  return `${length}${text}`;
}
/** A GitHub-style tarball: pax global header with the commit, then one top-level folder. */
function tarball(entries: Entry[], commit: string | null = COMMIT): Buffer {
  const parts: Buffer[] = [];
  if (commit) {
    const pax = Buffer.from(paxRecord('comment', commit));
    parts.push(header('pax_global_header', 'g', pax.length), padded(pax));
  }
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '');
    parts.push(header(entry.name, entry.type ?? (entry.name.endsWith('/') ? '5' : '0'), entry.type === '2' || entry.type === '1' ? 0 : body.length, entry.link));
    if (entry.type !== '2' && entry.type !== '1') parts.push(padded(body));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}
const good = [
  { name: 'engine-1.0.0/' }, { name: 'engine-1.0.0/gateway/' },
  { name: 'engine-1.0.0/gateway/entry.py', body: 'print("engine")\n' },
  { name: 'engine-1.0.0/README.md', body: '# engine\n' },
];

const root = await mkdtemp(join(tmpdir(), 'neo-engine-source-'));
const files = new Map<string, Buffer>();
let requests = 0;
const server: Server = createServer((request, response) => {
  requests++;
  const body = files.get(request.url ?? '');
  if (!body) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'content-type': 'application/x-gzip', 'content-length': body.length }).end(body);
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

let lockCount = 0;
async function scenario(archive: Buffer, pin: Record<string, unknown> = {}) {
  const dir = join(root, `case-${++lockCount}`);
  await mkdir(dir, { recursive: true });
  const sha = createHash('sha256').update(archive).digest('hex');
  const lockFile = join(dir, 'upstream.lock.json');
  await writeFile(lockFile, JSON.stringify({ schema_version: 1, pins: { engine: {
    kind: 'release', ref: 'v1.0.0', upstream: 'example/engine', commit: COMMIT, archive_sha256: sha, ...pin } } }));
  files.set('/example/engine/tar.gz/refs/tags/v1.0.0', archive);
  return { name: 'engine', lockFile, searchFrom: dir, upstreamCache: join(dir, 'no-dev-cache'), enginesDir: join(dir, 'engines'),
    probe: 'gateway/entry.py', downloadBase: base };
}
const failsWith = async (work: Promise<unknown>, kind: string, pattern: RegExp) => {
  await assert.rejects(work, (error: unknown) => error instanceof EngineInstallError && error.kind === kind && pattern.test(error.message));
};
const leftovers = (dir: string) => existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith('.tmp-')) : [];

try {
  // URL shape: release tags use refs/tags; https only, http only for loopback.
  assert.equal(engineDownloadUrl({ name: 'hermes-agent', kind: 'release', ref: 'v0.23.2', upstream: 'NousResearch/hermes-agent' }).href,
    'https://codeload.github.com/NousResearch/hermes-agent/tar.gz/refs/tags/v0.23.2');
  assert.throws(() => engineDownloadUrl({ name: 'x', kind: 'release', ref: 'v1', upstream: 'a/b' }, 'http://example.com'), /HTTPS/);
  assert.equal(safeEntryPath('engine-1.0.0/'), undefined);
  assert.equal(safeEntryPath('engine-1.0.0/a/b.txt'), 'a/b.txt');
  for (const bad of ['../x', 'engine/../../x', '/etc/passwd', 'C:/Windows/x', 'engine/a:stream']) {
    assert.throws(() => safeEntryPath(bad), (error: unknown) => error instanceof EngineInstallError && error.kind === 'unsafe', bad);
  }

  // Install, progress, marker, then reuse without a second download.
  const ok = await scenario(tarball(good));
  assert.equal(resolveEngineSource(ok), undefined, 'not installed yet');
  const phases = new Set<string>();
  const installed = await installEngineSource({ ...ok, onProgress: (progress) => phases.add(progress.phase) });
  assert.equal(installed.origin, 'app-data');
  assert.equal(installed.path, join(ok.enginesDir, 'engine@v1.0.0'));
  assert.equal(await readFile(join(installed.path, 'gateway/entry.py'), 'utf8'), 'print("engine")\n');
  assert.deepEqual([...phases], ['download', 'verify', 'extract']);
  assert.deepEqual(leftovers(ok.enginesDir), [], 'temp dir and download removed');
  const before = requests;
  assert.equal((await installEngineSource(ok)).path, installed.path);
  assert.equal(requests, before, 'an installed engine is reused');
  assert.equal(resolveEngineSource(ok)?.origin, 'app-data');

  // A pin change (new archive sha) invalidates the marker: the old install is not used.
  const changed = { ...ok, lockFile: join(root, 'changed.lock.json') };
  const lock = JSON.parse(await readFile(ok.lockFile, 'utf8'));
  lock.pins.engine.archive_sha256 = 'f'.repeat(64);
  await writeFile(changed.lockFile, JSON.stringify(lock));
  assert.equal(resolveEngineSource(changed), undefined, 'marker must match the pin');

  // Development cache wins over app data (unchanged dev behaviour).
  const dev = join(root, 'dev-cache', 'engine@v1.0.0', 'gateway');
  await mkdir(dev, { recursive: true }); await writeFile(join(dev, 'entry.py'), '');
  assert.deepEqual({ ...resolveEngineSource({ ...ok, upstreamCache: join(root, 'dev-cache') })!, pin: undefined },
    { path: join(root, 'dev-cache', 'engine@v1.0.0'), origin: 'dev-cache', pin: undefined });

  // Concurrent installs share one download.
  const shared = await scenario(tarball(good));
  const startRequests = requests;
  const [a, b] = await Promise.all([installEngineSource(shared), installEngineSource(shared)]);
  assert.equal(a.path, b.path); assert.equal(requests - startRequests, 1);

  // Refusals: nothing is left behind and the target is not created.
  const wrongSha = await scenario(tarball(good), { archive_sha256: '0'.repeat(64) });
  await failsWith(installEngineSource(wrongSha), 'verify', /sha256/);
  assert.ok(!existsSync(join(wrongSha.enginesDir, 'engine@v1.0.0'))); assert.deepEqual(leftovers(wrongSha.enginesDir), []);

  const wrongCommit = await scenario(tarball(good, 'b'.repeat(40)));
  await failsWith(installEngineSource(wrongCommit), 'verify', /commit/);
  assert.ok(!existsSync(join(wrongCommit.enginesDir, 'engine@v1.0.0')));

  const noCommit = await scenario(tarball(good, null));
  await failsWith(installEngineSource(noCommit), 'verify', /commit unknown/);

  const traversal = await scenario(tarball([...good, { name: 'engine-1.0.0/../../evil.txt', body: 'x' }]));
  await failsWith(installEngineSource(traversal), 'unsafe', /leaves the folder/);
  assert.ok(!existsSync(join(traversal.enginesDir, '..', 'evil.txt')) && !existsSync(join(traversal.enginesDir, 'evil.txt')));
  assert.deepEqual(leftovers(traversal.enginesDir), []);

  const symlink = await scenario(tarball([...good, { name: 'engine-1.0.0/link', type: '2', link: '../../outside' }]));
  await failsWith(installEngineSource(symlink), 'unsafe', /symbolic link/);
  const hardlink = await scenario(tarball([...good, { name: 'engine-1.0.0/hard', type: '1', link: 'engine-1.0.0/README.md' }]));
  await failsWith(installEngineSource(hardlink), 'unsafe', /hard link/);

  const twoRoots = await scenario(tarball([...good, { name: 'other/x.txt', body: 'x' }]));
  await failsWith(installEngineSource(twoRoots), 'unsafe', /more than one top-level folder/);

  const noProbe = await scenario(tarball([{ name: 'engine-1.0.0/' }, { name: 'engine-1.0.0/README.md', body: 'x' }]));
  await failsWith(installEngineSource(noProbe), 'verify', /no gateway\/entry\.py/);

  const notGzip = await scenario(Buffer.from('this is not a tarball'));
  await failsWith(installEngineSource(notGzip), 'verify', /not a valid tarball/);

  const missing = await scenario(tarball(good));
  files.clear();
  await failsWith(installEngineSource(missing), 'network', /HTTP 404/);
  const offline = { ...missing, downloadBase: 'http://127.0.0.1:1' };
  await failsWith(installEngineSource(offline), 'network', /failed/);

  const noPin = await scenario(tarball(good), { archive_sha256: undefined });
  await failsWith(installEngineSource(noPin), 'config', /no verified download/);

  const controller = new AbortController(); controller.abort();
  const aborted = await scenario(tarball(good));
  await failsWith(installEngineSource({ ...aborted, signal: controller.signal }), 'cancelled', /cancelled/);
  assert.deepEqual(leftovers(aborted.enginesDir), []);

  console.log('PASS engine source: dev cache first, app-data install verified by sha256 and commit, marker reuse, single download');
  console.log('PASS engine source refusals: sha, commit, traversal, symlink, hard link, two roots, missing probe, not gzip, HTTP/network, unpinned, cancelled');
} finally {
  await new Promise<void>((done) => server.close(() => done()));
  await rm(root, { recursive: true, force: true });
}
