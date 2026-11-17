import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependencyProblem, loadManifest, NeoKernel, resolveOrder, type ExtensionManifest, type LocatedExtension } from '@neometaharness/kernel';
import type { DatabaseProvider } from '@neometaharness/db';

function sample(id: string, dependsOn: Record<string, string> = {}, version = '1.2.0'): LocatedExtension {
  const manifest: ExtensionManifest = { id, displayName: id, version, runtime: { type: 'content' }, dependsOn };
  return { manifest, directory: id };
}

test('resolves dependencies before dependents', () => {
  const manifest = new Map([['b', sample('b', { a: '^1.0' })], ['a', sample('a')]]);
  assert.deepEqual(resolveOrder(manifest), ['a', 'b']);
});

test('rejects dependency cycles', () => {
  const manifest = new Map([['a', sample('a', { b: '^1.0' })], ['b', sample('b', { a: '^1.0' })]]);
  assert.throws(() => resolveOrder(manifest), /cycle/);
});

test('missing dependency degrades only the dependent', () => {
  const manifest = new Map([['a', sample('a', { missing: '^1.0' })], ['b', sample('b')]]);
  assert.deepEqual(resolveOrder(manifest), ['a', 'b']);
  assert.match(dependencyProblem(manifest.get('a')!.manifest, manifest)!, /Missing dependency/);
  assert.equal(dependencyProblem(manifest.get('b')!.manifest, manifest), undefined);
});

test('reports an incompatible dependency version', () => {
  const manifest = new Map([['a', sample('a', { b: '^2' })], ['b', sample('b')]]);
  assert.match(dependencyProblem(manifest.get('a')!.manifest, manifest)!, /does not satisfy/);
});

test('rejects invalid JSON schema and escaping entry paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nmh-manifest-'));
  try {
    const path = join(dir, 'neo.extension.json');
    await writeFile(path, JSON.stringify({ id: '../unsafe', version: '1.0.0', displayName: 'bad', runtime: { type: 'content' } }));
    await assert.rejects(loadManifest(dir), /Invalid manifest/);
    await writeFile(path, JSON.stringify({ id: 'safe', version: '1.0.0', displayName: 'safe', runtime: { type: 'cordis', entry: '../other.ts' } }));
    await assert.rejects(loadManifest(dir), /escapes install root/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('runtime missing dependency degrades, and disabling a provider unwinds dependents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nmh-dependency-'));
  const enabled = new Map<string, boolean>([['provider', true], ['dependent', true], ['missing-user', true]]);
  const db: DatabaseProvider = {
    migrate: async () => {},
    getEnabled: async (id) => enabled.get(id) ?? false,
    setEnabled: async (id, value) => { enabled.set(id, value); },
    close: async () => {},
  };
  const kernel = new NeoKernel(db);
  try {
    for (const [id, dependsOn] of [
      ['provider', {}],
      ['dependent', { provider: '^1.0.0' }],
      ['missing-user', { absent: '^1.0.0' }],
    ] as const) {
      const directory = join(root, id);
      await mkdir(directory);
      await writeFile(join(directory, 'neo.extension.json'), JSON.stringify({
        id, version: '1.0.0', displayName: id, runtime: { type: 'content' }, dependsOn,
      }));
    }
    await kernel.discover(root);
    assert.equal(kernel.status('provider').status, 'running');
    assert.equal(kernel.status('dependent').status, 'running');
    assert.equal(kernel.status('missing-user').status, 'degraded');
    assert.match(kernel.status('missing-user').reason!, /Missing dependency/);
    await kernel.disable('provider');
    assert.equal(kernel.status('dependent').status, 'degraded');
    await kernel.enable('provider');
    assert.equal(kernel.status('dependent').status, 'running');
  } finally {
    await kernel.close();
    await rm(root, { recursive: true, force: true });
  }
});
