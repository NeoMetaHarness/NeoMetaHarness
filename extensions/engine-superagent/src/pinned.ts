/**
 * The pinned dsh-superagent source (P7-16). It runs unmodified from the ref in upstream.lock.json: the development
 * cache in a checkout, else the copy the in-app install put in the engines folder (shared engine-source resolver).
 * The super agent has no build output of its own to run, so Neo bundles the five modules it uses with esbuild.
 * Their only package import is zod, left external so it resolves to this extension's zod, the one Neo's schemas
 * use; the DSH packages the worker needs ship in Neo's runtime. Nothing else (no Python, no Hermes) is needed
 * to start; tickets are worked by Hermes bots, which is a run-time need, not a start-up one.
 */
import { mkdir, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { resolveEngineSource, retrying, type EngineSource } from '@neometaharness/kernel';

const extensionDir = resolve(import.meta.dirname, '..');
const repoDir = resolve(extensionDir, '../..');
export const SUPERAGENT_PIN = 'dsh-superagent';
const SUPERAGENT_PROBE = 'src/core/engine.ts';

/**
 * upstream.lock.json of this repository or unpacked runtime. Isolated tests (NODE_ENV=test) may point at a
 * fixture lock whose pin matches a local fixture tarball; production always verifies against the shipped lock.
 */
export function superagentLockFile(): string {
  const fixture = process.env.NODE_ENV === 'test' ? process.env.NMH_TEST_UPSTREAM_LOCK : undefined;
  return fixture ?? join(repoDir, 'upstream.lock.json');
}

export function superagentSourceOptions(enginesDir?: string) {
  return { name: SUPERAGENT_PIN, lockFile: superagentLockFile(), searchFrom: repoDir, probe: SUPERAGENT_PROBE, ...(enginesDir ? { enginesDir } : {}) };
}

/** The pinned source to run, or undefined when it is neither in the development cache nor installed. */
export function resolveSuperagentSource(enginesDir?: string): EngineSource | undefined {
  return resolveEngineSource(superagentSourceOptions(enginesDir));
}

/**
 * Bundle the upstream modules Neo uses into this extension's `.cache` (inside the unpacked runtime, which is
 * replaced on update, so each version builds against its own packages). Written to a temp name and renamed, so a
 * reader never imports a half-written bundle. Returns the bundle path.
 */
export async function buildPinnedSuperagent(source: EngineSource): Promise<string> {
  const src = join(source.path, 'src');
  const outputDir = join(extensionDir, '.cache');
  await mkdir(outputDir, { recursive: true });
  const file = (part: string) => JSON.stringify(join(src, part).replaceAll('\\', '/'));
  const entry = [
    `export { Engine } from ${file('core/engine.ts')}`,
    `export { MemoryRepositories } from ${file('core/memory.ts')}`,
    `export { SourceRegistry } from ${file('sources/registry.ts')}`,
    `export { HealthBoard } from ${file('infra/health.ts')}`,
    `export { sourceContextOf } from ${file('app/source-context.ts')}`,
  ].join(';\n');
  const outfile = join(outputDir, `superagent-${source.pin.ref}-${source.origin}.mjs`);
  const temporary = `${outfile}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await build({
      stdin: { contents: entry, resolveDir: extensionDir, loader: 'ts' },
      bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node22', outfile: temporary,
      logLevel: 'silent',
    });
    await retrying(() => rename(temporary, outfile)); // Windows: antivirus briefly holds fresh files
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return outfile;
}

export async function loadPinnedSuperagent(source: EngineSource): Promise<Record<string, any>> {
  // One bundle name per ref and origin, so its content never changes and the module cache may reuse it.
  return import(pathToFileURL(await buildPinnedSuperagent(source)).href);
}
