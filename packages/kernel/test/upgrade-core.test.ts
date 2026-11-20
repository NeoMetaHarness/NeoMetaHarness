import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extensionIntegrity, NeoKernel } from '../src/index.js';
import { SqliteDatabaseProvider } from '@neometaharness/db';
const root = await mkdtemp(join(tmpdir(), 'neo-upgrade-core-'));
const installed = join(root, 'installed'); await mkdir(installed);
const versions = new Map<number, string>();
for (const version of [1, 2, 3, 4, 5, 6]) {
  const directory = join(version === 1 ? installed : root, `v${version}`); await mkdir(directory); versions.set(version, directory);
  await writeFile(join(directory, 'neo.extension.json'), JSON.stringify({ id: 'sample-ts', version: `${version}.0.0`, displayName: 'sample', kind: ['tool'], settings: { type: 'object', properties: { label: { type: 'string', default: `default-v${version}` }, custom: { type: 'string', default: 'unset' }, apiKey: { type: 'string', secret: true } } }, runtime: { type: 'cordis', entry: './index.mjs' } }));
  await writeFile(join(directory, 'index.mjs'), `export default { async activate(ctx) {
    const fixture=ctx.inject('fixture'); fixture.events.push('${version}:start');
    const settings=ctx.inject('settings'); fixture.settings.set(${version},settings);
    ctx.provide('sample', {version:${version}}); ctx.contribute('tools',{id:'sample.echo',version:${version}});
    ctx.effect(()=>()=>{fixture.events.push('${version}:stop');});
    if(${version}===4) {
      await fixture.lateActivation;
      for (const register of [()=>ctx.effect(()=>{fixture.lateEffects++;return ()=>{};}), ()=>ctx.route('late',()=>{}), ()=>ctx.onDrain(()=>{})]) {
        try { register(); } catch { fixture.rejectedLate++; }
      }
      fixture.activationStopped=ctx.signal.aborted;
      fixture.lateFinished();
      return;
    }
    ctx.health(async()=>{if(${version}===2) { fixture.started(); await fixture.healthGate; } if(${version}===5) await new Promise(done=>ctx.signal.addEventListener('abort',()=>{fixture.healthStopped=true;done();},{once:true})); return {ok:${version}!==3};});
    ctx.route('hello',async({body})=>{if(body?.slow) await fixture.requestGate; return {version:${version},settings:{...settings},storage:ctx.inject('extensionDataDir'),vault:ctx.inject('vault')===fixture.vault};});
    ctx.route('fail',async({body})=>{fixture.failures.push(${version}); if(body?.slow) await fixture.requestGate; throw fixture.routeError;});
  } };`);
}
const dependent = join(installed, 'consumer');
await mkdir(dependent);
await writeFile(join(dependent, 'neo.extension.json'), JSON.stringify({
  id: 'consumer', version: '1.0.0', displayName: 'Consumer', runtime: { type: 'cordis', entry: 'index.mjs' },
}));
await writeFile(join(dependent, 'index.mjs'), `export default { activate(ctx) {
  const sample = ctx.inject('sample');
  ctx.route('version', () => sample?.version);
} };`);
const db = new SqliteDatabaseProvider(join(root, 'gateway.db'));
let healthy!: () => void; let finish!: () => void; let started!: () => void;
const candidateStarted = new Promise<void>((done) => { started = done; });
const secrets = new Map<string, string>();
const vault = { get: async (_scope: unknown, name: string) => secrets.get(name), put: async (_scope: unknown, name: string, value: string) => { secrets.set(name, value); } };
let resumeActivation!: () => void; let lateFinished!: () => void;
const lateActivation = new Promise<void>(done => { resumeActivation = done; });
const lateDone = new Promise<void>(done => { lateFinished = done; });
const fixture = { events: [] as string[], failures: [] as number[], routeError: new Error('GitHub polling paused after HTTP 429'), settings: new Map<number, Record<string, unknown>>(), vault, healthGate: new Promise<void>((done) => { healthy = done; }), requestGate: new Promise<void>((done) => { finish = done; }), started,
  lateActivation, lateFinished, lateEffects: 0, rejectedLate: 0, activationStopped: false, healthStopped: false };
const services = { fixture, vault: fixture.vault, extensionDataDir: join(root, 'data') };
const kernel = new NeoKernel(db, services, root);
async function upgradeVersion(version: number, healthTimeoutMs?: number) {
  const directory = versions.get(version)!;
  return kernel.upgrade('sample-ts', directory, { integrity: await extensionIntegrity(directory), healthTimeoutMs });
}
try {
  await kernel.discover(installed);
  await kernel.saveSettings('sample-ts', { custom: 'persisted', apiKey: 'fake-key-before-upgrade' });
  await kernel.enable('sample-ts');
  assert.equal((await kernel.getSettings('sample-ts')).values.label, 'default-v1');
  assert.deepEqual((await kernel.getSettings('sample-ts')).sanitized.apiKey, { set: true });
  assert.equal((await db.getExtensionSettings('sample-ts'))?.apiKey, undefined, 'Secrets remain in the vault');
  const old = kernel.invokeRoute('/x/sample-ts/hello', 'RPC', { slow: true });
  const failedOld = assert.rejects(kernel.invokeRoute('/x/sample-ts/fail', 'RPC', { slow: true }), error => error === fixture.routeError);
  const next = versions.get(2)!;
  const wrong = await kernel.upgrade('sample-ts', next, { integrity: '0'.repeat(64) });
  assert.match(wrong.reason!, /integrity mismatch/);
  const integrity = await extensionIntegrity(next);
  const escape = join(next, 'escape');
  await symlink(installed, escape, process.platform === 'win32' ? 'junction' : 'dir');
  const unsafe = await kernel.upgrade('sample-ts', next, { integrity });
  assert.match(unsafe.reason!, /Symlink escapes extension tree/);
  await rm(escape);
  assert.deepEqual(fixture.events, ['1:start']);
  await kernel.enable('consumer');
  assert.equal(await kernel.invokeRoute('/x/consumer/version', 'GET'), 1);
  const eventAbort = new AbortController();
  const events = kernel.events.subscribe(0, AbortSignal.any([eventAbort.signal, AbortSignal.timeout(2000)]));
  const upgrade = upgradeVersion(2);
  await candidateStarted;
  assert.deepEqual(fixture.settings.get(2), { label: 'default-v2', custom: 'persisted', apiKey: 'fake-key-before-upgrade' });
  assert.equal((await kernel.getSettings('sample-ts')).values.label, 'default-v1', 'Candidate defaults must not leak before publication');
  let saved = false;
  const save = kernel.saveSettings('sample-ts', { custom: 'after-swap', apiKey: 'fake-key-after-upgrade' }).then(() => { saved = true; });
  await Promise.resolve();
  assert.equal(saved, false);
  assert.equal((await kernel.invokeRoute('/x/sample-ts/hello', 'GET') as any).version, 1);
  healthy();
  await save;
  assert.equal(kernel.status('sample-ts').version, '2.0.0');
  assert.ok(!fixture.events.includes('1:stop'));
  assert.equal(kernel.hasRoute('/x/consumer/version'), false, 'A suspended dependent cannot receive fresh requests against old services');
  while (true) {
    const emitted = await events.next();
    assert.equal(emitted.done, false, 'Upgrade must publish an event before retiring the old generation');
    const event = emitted.value;
    if (event?.type === 'extension.upgrade') {
      assert.equal(event.previousVersion, '1.0.0');
      assert.equal(event.version, '2.0.0');
      break;
    }
  }
  eventAbort.abort();
  await events.return(undefined);
  const newResponse = await kernel.invokeRoute('/x/sample-ts/hello', 'GET') as any;
  assert.deepEqual(newResponse.settings, { label: 'default-v2', custom: 'after-swap', apiKey: 'fake-key-after-upgrade' });
  assert.equal((await kernel.getSettings('sample-ts')).values.label, 'default-v2');
  assert.equal(newResponse.version, 2); assert.equal(newResponse.storage, services.extensionDataDir); assert.equal(newResponse.vault, true);
  await assert.rejects(kernel.invokeRoute('/x/sample-ts/fail', 'RPC'), error => error === fixture.routeError);
  finish(); const oldResponse = await old as any;
  await failedOld;
  assert.deepEqual(fixture.failures, [1, 2], 'A route failure is not replayed across the generation switch');
  assert.equal(oldResponse.version, 1);
  assert.deepEqual(oldResponse.settings, { label: 'default-v1', custom: 'persisted', apiKey: 'fake-key-before-upgrade' }, 'In-flight old code retains its generation settings');
  assert.equal((await upgrade).upgraded, true); assert.ok(fixture.events.includes('1:stop'));
  assert.equal(await kernel.invokeRoute('/x/consumer/version', 'GET'), 2);
  assert.equal(fixture.settings.get(2)!.custom, 'after-swap');
  assert.equal(fixture.settings.get(2)!.apiKey, 'fake-key-after-upgrade');
  assert.equal(fixture.settings.get(1)!.custom, 'persisted');
  const persisted = await db.getExtensionInstall('sample-ts');
  assert.equal(persisted?.directory, join(root, 'extensions', 'generations', 'sample-ts@2.0.0'));
  assert.equal(persisted?.integrity, integrity);
  assert.equal((await upgradeVersion(3)).upgraded, false);
  assert.equal(fixture.settings.get(3)!.label, 'default-v3');
  assert.equal((await kernel.getSettings('sample-ts')).values.label, 'default-v2', 'Failed health preserves active defaults and settings');
  assert.equal((await kernel.getSettings('sample-ts')).values.apiKey, 'fake-key-after-upgrade');
  const exposed = await kernel.getSettings('sample-ts'); exposed.values.label = 'outside mutation';
  assert.equal(fixture.settings.get(2)!.label, 'default-v2');
  assert.ok(fixture.events.includes('3:stop')); assert.equal(kernel.status('sample-ts').version, '2.0.0');
  const slowActivation = await upgradeVersion(4, 1000);
  assert.match(slowActivation.reason!, /activation timed out/);
  resumeActivation();
  assert.ok(fixture.events.includes('4:start'), 'Activation must start before its timeout');
  await lateDone;
  assert.equal(fixture.activationStopped, true);
  assert.equal(fixture.rejectedLate, 3);
  assert.equal(fixture.lateEffects, 0);
  assert.ok(!kernel.hasRoute('/x/sample-ts/late'));
  const slowHealth = await upgradeVersion(5, 1000);
  assert.match(slowHealth.reason!, /health check timed out/);
  assert.equal(fixture.healthStopped, true);
  assert.ok(fixture.events.includes('5:stop'));
  const persist = db.setExtensionInstall.bind(db);
  db.setExtensionInstall = async () => { throw new Error('test write failure'); };
  assert.match((await upgradeVersion(6)).reason!, /test write failure/);
  db.setExtensionInstall = persist;
  assert.ok(fixture.events.includes('6:stop'));
  assert.equal((await db.getExtensionInstall('sample-ts'))?.version, '2.0.0');
  assert.equal((await kernel.invokeRoute('/x/sample-ts/hello', 'GET') as any).version, 2);
  await writeFile(join(versions.get(3)!, 'neo.extension.json'), '{bad json');
  assert.equal((await upgradeVersion(3)).upgraded, false);
  await writeFile(join(versions.get(3)!, 'neo.extension.json'), JSON.stringify({
    id: 'sample-ts', version: '3.0.0', displayName: 'invalid settings',
    runtime: { type: 'cordis', entry: './index.mjs' },
    settings: { properties: { invalid: { type: 'unsupported' } } },
  }));
  assert.equal((await upgradeVersion(3)).upgraded, false);
  assert.equal((await kernel.getSettings('sample-ts')).values.label, 'default-v2');
  assert.equal(kernel.contributionIds().length, 1);
  console.log('PASS blue/green core: private staging, atomic route switch, old request drain, health/manifest rollback and stable storage/vault, generation settings, serialized saves and secret carryover');
} finally { finish(); healthy(); await kernel.close(); await rm(root, { recursive: true, force: true }); }
