import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

export async function loadPinnedSuperagent(): Promise<Record<string, any>> {
  const repo = resolve(import.meta.dirname, '../../..');
  const lock = JSON.parse(await readFile(join(repo, 'upstream.lock.json'), 'utf8')) as {
    pins: { 'dsh-superagent': { ref: string } };
  };
  const pinnedRef = lock.pins['dsh-superagent'].ref;
  const upstreamCache = resolve(repo, process.env.NMH_UPSTREAM_CACHE ?? '../nmh-upstream-cache');
  const source = join(upstreamCache, `dsh-superagent@${pinnedRef}`, 'src');
  const outputDir = resolve(import.meta.dirname, '../.cache');
  await mkdir(outputDir, { recursive: true });
  const file = (part: string) => JSON.stringify(join(source, part).replaceAll('\\', '/'));
  const entry = [
    `export { Engine } from ${file('core/engine.ts')}`,
    `export { MemoryRepositories } from ${file('core/memory.ts')}`,
    `export { SourceRegistry } from ${file('sources/registry.ts')}`,
    `export { HealthBoard } from ${file('infra/health.ts')}`,
    `export { sourceContextOf } from ${file('app/source-context.ts')}`,
  ].join(';\n');
  const outfile = join(outputDir, `superagent-${pinnedRef}.mjs`);
  await build({
    stdin: { contents: entry, resolveDir: resolve(import.meta.dirname, '..'), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node22', outfile,
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}
