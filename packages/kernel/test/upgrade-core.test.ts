import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NeoKernel } from '../src/index.js';
import { SqliteDatabaseProvider } from '@neometaharness/db';
const root = await mkdtemp(join(tmpdir(), 'neo-upgrade-core-'));
const installed = join(root, 'installed'); await mkdir(installed);
const versions = new Map<number, string>();
for (const version of [1, 2, 3]) {
  const directory = join(version === 1 ? installed : root, `v${version}`); await mkdir(directory); versions.set(version, directory);
  await writeFile(join(directory, 'neo.extension.json'), JSON.stringify({ id: 'sample-ts', version: `${version}.0.0`, displayName: 'sample', kind: ['tool'], settings: { type: 'object', properties: { label: { type: 'string', default: `default-v${version}` }, custom: { type: 'string', default: 'unset' }, apiKey: { type: 'string', secret: true } } }, runtime: { type: 'cordis', entry: './index.mjs' } }));
  await writeFile(join(directory, 'index.mjs'), `export default { activate(ctx) {
    const fixture=ctx.inject('fixture'); fixture.events.push('${version}:start');
    const settings=ctx.inject('settings'); fixture.settings.set(${version},settings);
    ctx.provide('sample', {version:${version}}); ctx.contribute('tools',{id:'sample.echo',version:${version}});
    ctx.effect(()=>()=>{fixture.events.push('${version}:stop');});
    ctx.health(async()=>{if(${version}===2) { fixture.started(); await fixture.healthGate; } return {ok:${version}!==3};});
    ctx.route('hello',async({body})=>{if(body?.slow) await fixture.requestGate; return {version:${version},settings:{...settings},storage:ctx.inject('extensionDataDir'),vault:ctx.inject('vault')===fixture.vault};});
  } };`);
}
const db = new SqliteDatabaseProvider(join(root, 'gateway.db'));
let healthy!: () => void; let finish!: () => void; let started!: () => void;
const candidateStarted = new Promise<void>((done) => { started = done; });
const secrets = new Map<string, string>();
const vault = { get: async (_scope: unknown, name: string) => secrets.get(name), put: async (_scope: unknown, name: string, value: string) => { secrets.set(name, value); } };
const fixture = { events: [] as string[], settings: new Map<number, Record<string, unknown>>(), vault, healthGate: new Promise<void>((done) => { healthy = done; }), requestGate: new Promise<void>((done) => { finish = done; }), started };
const services = { fixture, vault: fixture.vault, extensionDataDir: join(root, 'data') };
const kernel = new NeoKernel(db, services);
try {
  await kernel.discover(installed);
  await kernel.saveSettings('sample-ts', { custom: 'persisted', apiKey: 'fake-key-before-upgrade' });
  await kernel.enable('sample-ts');
  assert.equal((await kernel.getSettings('sample-ts')).values.label, 'default-v1');
  assert.deepEqual((await kernel.getSettings('sample-ts')).sanitized.apiKey, { set: true });
  assert.equal((await db.getExtensionSettings('sample-ts'))?.apiKey, undefined, 'Secrets remain in the vault');
  const old = kernel.invokeRoute('/x/sample-ts/hello', 'RPC', { slow: true });
  const upgrade = kernel.upgrade('sample-ts', versions.get(2)!);
  await candidateStarted;
  assert.deepEqual(fixture.settings.get(2), { label: 'default-v2', custom: 'persisted', apiKey: 'fake-key-before-upgrade' });
  assert.equal((await kernel.getSettings('sample-ts')).values.label, 'default-v1', 'Candidate defaults must not leak before publication');
  let saved = false;
  const save = kernel.saveSettings('sample-ts', { custom: 'after-swap', apiKey: 'fake-key-after-upgrade' }).then(() => { saved = true; });
  await Promise.resolve();
  assert.equal(saved, false);
  assert.equal((await kernel.invokeRoute('/x/sample-ts/hello', 'GET') as any).version, 1);
  healthy();
  while (kernel.status('sample-ts').version !== '2.0.0') await new Promise((done) => setTimeout(done, 5));
  assert.ok(!fixture.events.includes('1:stop'));
  const newResponse = await kernel.invokeRoute('/x/sample-ts/hello', 'GET') as any;
  assert.deepEqual(newResponse.settings, { label: 'default-v2', custom: 'persisted', apiKey: 'fake-key-before-upgrade' });
  assert.equal((await kernel.getSettings('sample-ts')).values.label, 'default-v2');
  assert.equal(newResponse.version, 2); assert.equal(newResponse.storage, services.extensionDataDir); assert.equal(newResponse.vault, true);
  finish(); const oldResponse = await old as any;
  assert.equal(oldResponse.version, 1);
  assert.deepEqual(oldResponse.settings, { label: 'default-v1', custom: 'persisted', apiKey: 'fake-key-before-upgrade' }, 'In-flight old code retains its generation settings');
  assert.equal((await upgrade).upgraded, true); assert.ok(fixture.events.includes('1:stop'));
  await save;
  assert.equal(fixture.settings.get(2)!.custom, 'after-swap');
  assert.equal(fixture.settings.get(2)!.apiKey, 'fake-key-after-upgrade');
  assert.equal(fixture.settings.get(1)!.custom, 'persisted');
  assert.equal((await db.getExtensionInstall('sample-ts'))?.version, '2.0.0');
  assert.equal((await kernel.upgrade('sample-ts', versions.get(3)!)).upgraded, false);
  assert.equal(fixture.settings.get(3)!.label, 'default-v3');
  assert.equal((await kernel.getSettings('sample-ts')).values.label, 'default-v2', 'Failed health preserves active defaults and settings');
  assert.equal((await kernel.getSettings('sample-ts')).values.apiKey, 'fake-key-after-upgrade');
  const exposed = await kernel.getSettings('sample-ts'); exposed.values.label = 'outside mutation';
  assert.equal(fixture.settings.get(2)!.label, 'default-v2');
  assert.ok(fixture.events.includes('3:stop')); assert.equal(kernel.status('sample-ts').version, '2.0.0');
  assert.equal((await kernel.invokeRoute('/x/sample-ts/hello', 'GET') as any).version, 2);
  await writeFile(join(versions.get(3)!, 'neo.extension.json'), '{bad json');
  assert.equal((await kernel.upgrade('sample-ts', versions.get(3)!)).upgraded, false);
  await writeFile(join(versions.get(3)!, 'neo.extension.json'), JSON.stringify({
    id: 'sample-ts', version: '3.0.0', displayName: 'invalid settings',
    runtime: { type: 'cordis', entry: './index.mjs' },
    settings: { properties: { invalid: { type: 'unsupported' } } },
  }));
  assert.equal((await kernel.upgrade('sample-ts', versions.get(3)!)).upgraded, false);
  assert.equal((await kernel.getSettings('sample-ts')).values.label, 'default-v2');
  assert.equal(kernel.contributionIds().length, 1);
  console.log('PASS blue/green core: private staging, atomic route switch, old request drain, health/manifest rollback and stable storage/vault, generation settings, serialized saves and secret carryover');
} finally { finish(); healthy(); await kernel.close(); await rm(root, { recursive: true, force: true }); }
