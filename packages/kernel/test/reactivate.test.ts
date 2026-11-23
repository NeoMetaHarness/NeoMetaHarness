// P7-16: ctx.reactivate() restarts an extension whose runtime was installed while it ran, and its dependents.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDatabaseProvider } from '@neometaharness/db';
import { NeoKernel } from '../src/index.js';

const root = await mkdtemp(join(tmpdir(), 'neo-reactivate-'));
const extensions = join(root, 'extensions');
const flag = join(root, 'installed');
const log = join(root, 'log');
await mkdir(log, { recursive: true });
const write = async (id: string, manifest: object, code: string) => {
  await mkdir(join(extensions, id), { recursive: true });
  await writeFile(join(extensions, id, 'neo.extension.json'), JSON.stringify({ id, version: '0.1.0', displayName: id,
    kind: ['engine'], runtime: { type: 'cordis', entry: './index.mjs' }, ...manifest }));
  await writeFile(join(extensions, id, 'index.mjs'), code);
};
// "engine" activates in install mode until the flag exists; its install route triggers ctx.reactivate().
await write('engine', {}, `import { existsSync } from 'node:fs'; import { writeFile } from 'node:fs/promises';
let generation = 0;
export default { activate(ctx) {
  const mine = ++generation;
  const installed = existsSync(${JSON.stringify(flag)});
  if (installed) ctx.provide('engineRuntime', { generation: mine });
  ctx.health(() => ({ ok: installed }));
  ctx.route('status', () => ({ installed, generation: mine }));
  ctx.route('install', async () => { await writeFile(${JSON.stringify(flag)}, 'yes'); void ctx.reactivate(); return { ok: true }; });
  ctx.route('stale', () => { void ctx.reactivate(); return { ok: true }; });
  globalThis.staleReactivate ??= () => ctx.reactivate();
} };`);
await write('dependent', { dependsOn: { engine: '^0.1.0' } }, `export default { activate(ctx) {
  const runtime = ctx.inject('engineRuntime');
  if (!runtime) throw new Error('Dependent needs the engine runtime');
  ctx.route('hello', () => ({ engine: runtime.generation }));
} };`);
await write('bystander', {}, `export default { activate(ctx) { ctx.route('hello', () => 'still here'); } };`);

const db = new SqliteDatabaseProvider(join(root, 'gateway.db'));
const kernel = new NeoKernel(db, { extensionDataDir: join(root, 'data') }, root);
const eventually = async (check: () => boolean | Promise<boolean>, label: string) => {
  for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await new Promise((done) => setTimeout(done, 25)); }
  throw new Error(`Timed out: ${label}`);
};
try {
  await kernel.discover(extensions);
  for (const id of ['engine', 'dependent', 'bystander']) await kernel.enable(id);
  const status = (id: string) => kernel.list().find((row) => row.id === id)!;
  assert.equal(status('engine').status, 'running');
  assert.equal(status('dependent').status, 'degraded');
  assert.match(status('dependent').reason ?? '', /needs the engine runtime/);
  assert.deepEqual(await kernel.invokeRoute('/x/engine/status', 'RPC'), { installed: false, generation: 1 });

  await kernel.invokeRoute('/x/engine/install', 'RPC');
  await eventually(() => status('dependent').status === 'running', 'dependent recovers after reactivate');
  assert.deepEqual(await kernel.invokeRoute('/x/engine/status', 'RPC'), { installed: true, generation: 2 });
  assert.deepEqual(await kernel.invokeRoute('/x/dependent/hello', 'RPC'), { engine: 2 });
  assert.equal(await kernel.invokeRoute('/x/bystander/hello', 'RPC'), 'still here');

  // A running dependent restarts with its provider, on the new generation.
  await kernel.invokeRoute('/x/engine/stale', 'RPC');
  await eventually(async () => (await kernel.invokeRoute('/x/dependent/hello', 'RPC') as { engine: number } | undefined)?.engine === 3, 'dependent follows the new generation');
  assert.equal(status('engine').status, 'running');

  // A retired generation's reactivate() is a no-op (here: generation 1's, after disable).
  await kernel.disable('engine');
  assert.equal(status('dependent').status, 'degraded');
  await (globalThis as { staleReactivate?: () => Promise<void> }).staleReactivate!();
  assert.equal(status('engine').status, 'disabled', 'a stale reactivate does not re-enable');
  assert.ok(existsSync(flag));
  console.log('PASS reactivate: install-mode engine restarts, degraded dependent recovers, running dependent follows, stale call is a no-op');
} finally {
  await kernel.close();
  await rm(root, { recursive: true, force: true });
}
