// P7-16 review: the super agent bundle is built once and reused while it matches what it was built from; anything
// stale (another source install, a changed entry, a missing or edited sidecar) rebuilds it. Runs on the pinned
// source in the development cache, into a temp folder.
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireUpstreamCache } from '../../../tests/upstream-cache.mjs';
import { ensureSuperagentBundle, loadPinnedSuperagent, resolveSuperagentSource } from '../src/pinned.js';

const sidecarOf = (bundle: string) => bundle.replace(/\.mjs$/, '.built');
requireUpstreamCache('extensions/engine-superagent/test/bundle.test.ts', ['dsh-superagent']);
const temp = await mkdtemp(join(tmpdir(), 'nmh-superagent-bundle-'));
// Inside this extension, as in production, so the bundle's external zod resolves to the extension's.
const out = join(fileURLToPath(new URL('../.cache/', import.meta.url)), `bundle-test-${process.pid}`);
try {
  const source = resolveSuperagentSource();
  assert.ok(source, 'the development cache holds the pinned source');

  // First use builds, and the bundle runs.
  const first = await ensureSuperagentBundle(source, out);
  assert.equal(first.built, true);
  assert.ok(existsSync(sidecarOf(first.path)), 'sidecar written after the bundle');
  const upstream = await loadPinnedSuperagent(first);
  assert.equal(typeof upstream.Engine, 'function');

  // Same source: reused, the file untouched (no second build, e.g. on the reactivation after an install).
  const before = statSync(first.path).mtimeMs;
  const again = await ensureSuperagentBundle(source, out);
  assert.deepEqual({ built: again.built, path: again.path, key: again.key }, { built: false, path: first.path, key: first.key });
  assert.equal(statSync(first.path).mtimeMs, before);

  // A sidecar that does not match (another build, a crash between bundle and sidecar) is never trusted.
  await writeFile(sidecarOf(first.path), first.key.replace(/"commit":"[^"]*"/, '"commit":"0000000000000000000000000000000000000000"'));
  assert.equal((await ensureSuperagentBundle(source, out)).built, true, 'edited sidecar rebuilds');
  await rm(sidecarOf(first.path));
  assert.equal((await ensureSuperagentBundle(source, out)).built, true, 'missing sidecar rebuilds');
  await rm(first.path);
  assert.equal((await ensureSuperagentBundle(source, out)).built, true, 'missing bundle rebuilds');
  assert.equal((await ensureSuperagentBundle(source, out)).built, false);

  // An app-data install of another download (its marker) is a different source: rebuilt, and imported fresh.
  const installed = join(temp, 'engines', `dsh-superagent@${source.pin.ref}`);
  await cp(join(source.path, 'src'), join(installed, 'src'), { recursive: true });
  const marker = { name: source.pin.name, ref: source.pin.ref, commit: source.pin.commit, archive_sha256: 'a'.repeat(64) };
  await writeFile(join(installed, '.neo-engine.json'), JSON.stringify(marker));
  const appData = { ...source, path: installed, origin: 'app-data' as const };
  const fromInstall = await ensureSuperagentBundle(appData, out);
  assert.equal(fromInstall.built, true);
  assert.equal((await ensureSuperagentBundle(appData, out)).built, false);
  await writeFile(join(installed, '.neo-engine.json'), JSON.stringify({ ...marker, archive_sha256: 'b'.repeat(64) }));
  const reinstalled = await ensureSuperagentBundle(appData, out);
  assert.equal(reinstalled.built, true, 'a reinstalled source rebuilds');
  assert.notEqual(reinstalled.key, fromInstall.key);
  assert.equal(JSON.parse(await readFile(sidecarOf(reinstalled.path), 'utf8')).archive_sha256, 'b'.repeat(64));
  assert.equal(typeof (await loadPinnedSuperagent(reinstalled)).Engine, 'function');

  console.log('P7-16 SUPERAGENT BUNDLE PASS first=built same=reused edited_sidecar=rebuilt missing_sidecar=rebuilt missing_bundle=rebuilt reinstall=rebuilt');
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await rm(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
