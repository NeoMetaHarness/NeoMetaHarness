// P1-13 review: per-workspace settings across a blue/green generation switch, and the server-mode legacy
// migration when the first workspace appears after start.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extensionIntegrity, NeoKernel } from '../src/index.js';
import { SqliteDatabaseProvider } from '@neometaharness/db';
import { unsealFixtureTree } from './upgrade-fixtures.js';

const root = await mkdtemp(join(tmpdir(), 'neo-workspace-settings-'));
const installed = join(root, 'installed');
const versions = new Map<number, string>();
for (const version of [1, 2, 3, 4]) {
  const directory = join(version === 1 ? installed : root, `v${version}`);
  await mkdir(directory, { recursive: true }); versions.set(version, directory);
  await writeFile(join(directory, 'neo.extension.json'), JSON.stringify({ id: 'sample-ws', version: `${version}.0.0`,
    displayName: 'sample', kind: ['tool'], runtime: { type: 'cordis', entry: './index.mjs' },
    settings: { type: 'object', properties: { label: { type: 'string', default: 'unset' }, apiKey: { type: 'string', secret: true } } } }));
  await writeFile(join(directory, 'index.mjs'), `export default { activate(ctx) {
    const settings = ctx.inject('settings');
    ctx.health(() => ({ ok: true }));
    ctx.route('hello', () => ({ version: ${version}, label: settings.label, apiKey: settings.apiKey ?? null }));
  } };`);
}
const secrets = new Map<string, string>();
const key = (scope: { workspaceId: string; subjectId?: string }, name: string) => `${scope.workspaceId}/${scope.subjectId}/${name}`;
// A gate that holds one workspace's secret read open (to stretch a settings load across a generation switch).
let hold: { workspace: string; reached: () => void; release: Promise<void> } | undefined;
const vault = {
  get: async (scope: any, name: string) => {
    if (hold && scope.workspaceId === hold.workspace) { const gate = hold; hold = undefined; gate.reached(); await gate.release; }
    return secrets.get(key(scope, name));
  },
  put: async (scope: any, name: string, value: string) => { secrets.set(key(scope, name), value); },
  delete: async (scope: any, name: string) => secrets.delete(key(scope, name)),
};
const db = new SqliteDatabaseProvider(join(root, 'gateway.db'));
let firstWorkspace: string | undefined;
// Server mode: no fallback workspace; the bootstrap workspace does not exist yet when the kernel starts.
const kernel = new NeoKernel(db, { vault, extensionDataDir: join(root, 'data') }, root, undefined,
  { fallbackWorkspace: null, legacyWorkspace: async () => firstWorkspace });
try {
  // An upgraded deployment: settings stored before P1-13, with no workspace.
  await db.migrate();
  await db.setExtensionSettings('sample-ws', { label: 'legacy' });
  secrets.set('default/sample-ws/SEC_APIKEY', 'legacy-key');
  await kernel.discover(installed);
  assert.equal((await db.listLegacyExtensionSettings()).length, 1, 'no workspace yet: legacy rows are kept');
  await kernel.enable('sample-ws');

  // The first workspace is created later; the first access to it runs the migration (no restart needed).
  firstWorkspace = 'org-first';
  assert.deepEqual(await kernel.runInWorkspace('org-first', () => kernel.invokeRoute('/x/sample-ws/hello', 'GET')),
    { version: 1, label: 'legacy', apiKey: 'legacy-key' }, 'legacy values reach the first workspace on first access');
  assert.deepEqual(await db.listLegacyExtensionSettings(), [], 'legacy rows moved');
  assert.equal(secrets.get('default/sample-ws/SEC_APIKEY'), undefined, 'legacy secret moved');
  assert.equal((await kernel.getSettings('sample-ws', 'org-other')).values.label, 'unset', 'other workspaces do not inherit them');
  console.log('P1-13_LAZY_MIGRATION PASS legacy settings move into the first workspace when it appears');

  // A request in workspace A preloads A's snapshot, then the extension switches generation before the route runs.
  await kernel.saveSettings('sample-ws', { label: 'alpha', apiKey: 'alpha-key' }, 'org-a');
  await kernel.saveSettings('sample-ws', { label: 'beta', apiKey: 'beta-key' }, 'org-b');
  const directory = versions.get(2)!;
  const served = await kernel.runInWorkspace('org-a', async () => {
    const upgraded = await kernel.upgrade('sample-ws', directory, { integrity: await extensionIntegrity(directory) });
    assert.equal(upgraded.upgraded, true, upgraded.reason);
    return kernel.invokeRoute('/x/sample-ws/hello', 'GET');
  });
  assert.deepEqual(served, { version: 2, label: 'alpha', apiKey: 'alpha-key' }, 'the new generation serves A with A\'s settings');
  // Concurrent requests in two workspaces against the new generation keep their own values.
  const [a, b] = await Promise.all([
    kernel.runInWorkspace('org-a', () => kernel.invokeRoute('/x/sample-ws/hello', 'GET')),
    kernel.runInWorkspace('org-b', () => kernel.invokeRoute('/x/sample-ws/hello', 'GET')),
  ]);
  assert.deepEqual([a, b], [{ version: 2, label: 'alpha', apiKey: 'alpha-key' }, { version: 2, label: 'beta', apiKey: 'beta-key' }]);
  console.log('P1-13_GENERATION_SWITCH PASS a route reached after a generation switch reads its workspace settings');

  // invokeRoute's settings load for a new generation (v3) is held open, and v3 retires meanwhile (upgrade to v4):
  // the request must be re-resolved to v4, not sent to the retired v3 nor served with defaults.
  await kernel.saveSettings('sample-ws', { label: 'gamma', apiKey: 'gamma-key' }, 'org-c');
  let reached!: () => void; let release!: () => void;
  const atLoad = new Promise<void>((done) => { reached = done; });
  const upgrade = async (version: number) => {
    const directory = versions.get(version)!;
    const result = await kernel.upgrade('sample-ws', directory, { integrity: await extensionIntegrity(directory) });
    assert.equal(result.upgraded, true, result.reason);
  };
  const switched = kernel.runInWorkspace('org-c', async () => {
    await upgrade(3); // v3 becomes active after runInWorkspace preloaded org-c for v2
    hold = { workspace: 'org-c', reached, release: new Promise<void>((done) => { release = done; }) };
    return kernel.invokeRoute('/x/sample-ws/hello', 'GET');
  });
  await atLoad;
  await upgrade(4);
  release();
  assert.deepEqual(await switched, { version: 4, label: 'gamma', apiKey: 'gamma-key' },
    'the request is served by the current generation with its workspace settings');
  console.log('P1-13_RETIRING_GENERATION PASS a settings load spanning a switch re-resolves to the serving generation');
} finally {
  await kernel.close?.();
  db.close?.();
  await unsealFixtureTree(root);
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}
