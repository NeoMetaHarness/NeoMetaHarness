/**
 * The pinned dsh-superagent source (P7-16). It runs unmodified from the ref in upstream.lock.json: the development
 * cache in a checkout, else the copy the in-app install put in the engines folder (shared engine-source resolver).
 * The super agent has no build output of its own to run, so Neo bundles the five modules it uses with esbuild.
 * Their only package import is zod, left external so it resolves to this extension's zod, the one Neo's schemas
 * use; the DSH packages the worker needs ship in Neo's runtime. Nothing else (no Python, no Hermes) is needed
 * to start; tickets are worked by Hermes bots, which is a run-time need, not a start-up one.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';
import { resolveEngineSource, retrying, upstreamLockFile, type EngineSource } from '@neometaharness/kernel';

const extensionDir = resolve(import.meta.dirname, '..');
const repoDir = resolve(extensionDir, '../..');
export const SUPERAGENT_PIN = 'dsh-superagent';
const SUPERAGENT_PROBE = 'src/core/engine.ts';

/** upstream.lock.json of the Gateway's runtime root, else of this source tree (see upstreamLockFile). */
export function superagentLockFile(runtimeRoot?: string): string {
  return upstreamLockFile(runtimeRoot, repoDir);
}

export function superagentSourceOptions(enginesDir?: string, runtimeRoot?: string) {
  return { name: SUPERAGENT_PIN, lockFile: superagentLockFile(runtimeRoot), searchFrom: repoDir, probe: SUPERAGENT_PROBE, ...(enginesDir ? { enginesDir } : {}) };
}

/** The pinned source to run, or undefined when it is neither in the development cache nor installed. */
export function resolveSuperagentSource(enginesDir?: string, runtimeRoot?: string): EngineSource | undefined {
  return resolveEngineSource(superagentSourceOptions(enginesDir, runtimeRoot));
}

export interface SuperagentBundle { path: string; key: string; built: boolean }

/**
 * What the bundle is built from. A sidecar `<bundle>.json` records it after the bundle is in place, and the bundle
 * is reused only while every field matches: the installed source (its install marker's commit and archive sha256,
 * else the lock's pin), the source folder, the entry that names the upstream modules, this extension's version and
 * esbuild's. Anything else changing rebuilds it.
 */
async function bundleKey(source: EngineSource, entry: string): Promise<string> {
  const marker = await readFile(join(source.path, '.neo-engine.json'), 'utf8').then((text) => JSON.parse(text) as Record<string, unknown>, () => undefined);
  const manifest = JSON.parse(await readFile(join(extensionDir, 'neo.extension.json'), 'utf8')) as { version: string };
  return JSON.stringify({
    name: source.pin.name, ref: source.pin.ref, origin: source.origin, source: resolve(source.path),
    commit: marker?.commit ?? source.pin.commit ?? null, archive_sha256: marker?.archive_sha256 ?? source.pin.archive_sha256 ?? null,
    extension: manifest.version, esbuild: esbuildVersion, entry: createHash('sha256').update(entry).digest('hex'),
  });
}

/**
 * The bundle of the upstream modules Neo uses, built when missing or stale. It lives in this extension's `.cache`
 * (inside the unpacked runtime, which is replaced on update, so each version builds against its own packages). The
 * bundle is written under a temp name and renamed, then its sidecar the same way, so a reader never sees a
 * half-written bundle or a sidecar for a bundle that is not there yet.
 */
export async function ensureSuperagentBundle(source: EngineSource, outputDir = join(extensionDir, '.cache')): Promise<SuperagentBundle> {
  const src = join(source.path, 'src');
  const file = (part: string) => JSON.stringify(join(src, part).replaceAll('\\', '/'));
  const entry = [
    `export { Engine } from ${file('core/engine.ts')}`,
    `export { MemoryRepositories } from ${file('core/memory.ts')}`,
    `export { SourceRegistry } from ${file('sources/registry.ts')}`,
    `export { HealthBoard } from ${file('infra/health.ts')}`,
    `export { sourceContextOf } from ${file('app/source-context.ts')}`,
  ].join(';\n');
  const key = await bundleKey(source, entry);
  // The name carries the key's hash: a rebuilt bundle is a new module URL, so the module cache never serves a stale
  // one, while a reactivation that reuses the bundle reuses the loaded module.
  const prefix = `superagent-${source.pin.ref}-${source.origin}-`;
  const base = join(outputDir, `${prefix}${createHash('sha256').update(key).digest('hex').slice(0, 16)}`);
  const outfile = `${base}.mjs`;
  // Not `<bundle>.json`: tsx resolves an import of `x.mjs` to `x.mjs.json` when that file exists.
  const sidecar = `${base}.built`;
  if (existsSync(outfile) && await readFile(sidecar, 'utf8').catch(() => '') === key) return { path: outfile, key, built: false };

  await mkdir(outputDir, { recursive: true });
  const suffix = `${randomBytes(6).toString('hex')}.tmp`;
  try {
    await rm(sidecar, { force: true }); // a bundle being replaced is never described by the old sidecar
    await build({
      stdin: { contents: entry, resolveDir: extensionDir, loader: 'ts' },
      bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node22', outfile: `${outfile}.${suffix}`,
      logLevel: 'silent',
    });
    // Windows: antivirus briefly holds fresh files.
    await retrying(() => rename(`${outfile}.${suffix}`, outfile));
    await writeFile(`${sidecar}.${suffix}`, key);
    await retrying(() => rename(`${sidecar}.${suffix}`, sidecar));
  } finally {
    await rm(`${outfile}.${suffix}`, { force: true }).catch(() => {});
    await rm(`${sidecar}.${suffix}`, { force: true }).catch(() => {});
  }
  // Older bundles of this ref and origin are no longer used (best effort: one may still be loading elsewhere).
  for (const name of await readdir(outputDir).catch(() => [] as string[])) {
    if (name.startsWith(prefix) && !join(outputDir, name).startsWith(`${base}.`) && !name.endsWith('.tmp')) {
      await rm(join(outputDir, name), { force: true }).catch(() => {});
    }
  }
  return { path: outfile, key, built: true };
}

export async function loadPinnedSuperagent(bundle: SuperagentBundle): Promise<Record<string, any>> {
  return import(pathToFileURL(bundle.path).href);
}
