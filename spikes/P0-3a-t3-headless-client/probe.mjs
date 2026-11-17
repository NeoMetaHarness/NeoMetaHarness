import { build } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = process.env.T3_SOURCE ?? path.resolve(here, '../../../../nmh-upstream-cache/t3code@v0.1.9');
const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (commit !== '24e77473ecf41bc1f7142529c7911c1c1aae1d76') {
  throw new Error(`Ref mismatch: expected pinned v0.1.9, found ${commit}`);
}
const buildDir = path.join(here, '.cache');
await mkdir(buildDir, { recursive: true });
const aliasPaths = {
  '@t3tools/contracts': 'packages/contracts/src/index.ts',
  '@t3tools/contracts/relay': 'packages/contracts/src/relay.ts',
  '@t3tools/client-runtime/connection-compatibility': 'packages/client-runtime/src/connection/compatibility.ts',
  '@t3tools/client-runtime/rpc-protocol': 'packages/client-runtime/src/rpc/protocol.ts',
};
const output = path.join(buildDir, 'probe.bundle.mjs');
await build({
  entryPoints: [path.join(here, 'probe.entry.ts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  nodePaths: [path.join(here, 'node_modules')],
  plugins: [{
    name: 'pinned-t3-source-only',
    setup(builder) {
      builder.onResolve({ filter: /^@t3tools\// }, args => aliasPaths[args.path] ? ({
        path: path.join(source, aliasPaths[args.path]),
      }) : undefined);
    },
  }],
});
const args = process.argv.includes('--live') ? ['--live'] : [];
const child = spawnSync(process.execPath, [output, ...args], {
  stdio: 'inherit',
  env: process.env,
  timeout: 20000,
});
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;