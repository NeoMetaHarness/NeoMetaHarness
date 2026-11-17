import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
const here = path.dirname(fileURLToPath(import.meta.url));
const source = process.env.T3_SOURCE ?? path.resolve(here, '../../../../nmh-upstream-cache/t3code@v0.1.9');
const sha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (sha !== '24e77473ecf41bc1f7142529c7911c1c1aae1d76') throw new Error(`T3 source SHA mismatch: ${sha}`);
const out = path.join(here, '.cache/live.bundle.mjs');
await mkdir(path.dirname(out), { recursive: true });
await build({
  entryPoints: [path.join(here, 'live.entry.ts')], outfile: out, bundle: true,
  platform: 'node', target: 'node22', format: 'esm',
  nodePaths: [path.join(here, 'node_modules')],
  plugins: [{ name: 'pinned-t3-source', setup(b) {
    const aliases = {
      '@t3tools/contracts': 'packages/contracts/src/index.ts',
      '@t3tools/contracts/relay': 'packages/contracts/src/relay.ts',
      '@t3tools/client-runtime/rpc-protocol': 'packages/client-runtime/src/rpc/protocol.ts',
    };
    b.onResolve({ filter: /^@t3tools\// }, args => aliases[args.path] ? ({ path: path.join(source, aliases[args.path]) }) : undefined);
  } }],
});
console.log('live_client_bundle=PASS pinned_sha=' + sha.slice(0, 7));
if (!process.argv.includes('--compile-only')) await import(pathToFileURL(out).href);
