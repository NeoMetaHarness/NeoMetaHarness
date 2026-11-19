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
  await writeFile(join(directory, 'neo.extension.json'), JSON.stringify({ id: 'sample-ts', version: `${version}.0.0`, displayName: 'sample', kind: ['tool'], runtime: { type: 'cordis', entry: './index.mjs' } }));
  await writeFile(join(directory, 'index.mjs'), `export default { activate(ctx) {
    const fixture=ctx.inject('fixture'); fixture.events.push('${version}:start');
    ctx.provide('sample', {version:${version}}); ctx.contribute('tools',{id:'sample.echo',version:${version}});
    ctx.effect(()=>()=>{fixture.events.push('${version}:stop');});
    ctx.health(async()=>{if(${version}===2) { fixture.started(); await fixture.healthGate; } return {ok:${version}!==3};});
    ctx.route('hello',async({body})=>{if(body?.slow) await fixture.requestGate; return {version:${version},storage:ctx.inject('extensionDataDir'),vault:ctx.inject('vault')===fixture.vault};});
  } };`);
}
const db = new SqliteDatabaseProvider(join(root, 'gateway.db'));
let healthy!: () => void; let finish!: () => void; let started!: () => void;
const candidateStarted = new Promise<void>((done) => { started = done; });
const fixture = { events: [] as string[], vault: {}, healthGate: new Promise<void>((done) => { healthy = done; }), requestGate: new Promise<void>((done) => { finish = done; }), started };
const services = { fixture, vault: fixture.vault, extensionDataDir: join(root, 'data') };
const kernel = new NeoKernel(db, services);
try {
  await kernel.discover(installed); await kernel.enable('sample-ts');
  const old = kernel.invokeRoute('/x/sample-ts/hello', 'RPC', { slow: true });
  const upgrade = kernel.upgrade('sample-ts', versions.get(2)!);
  await candidateStarted;
  assert.equal((await kernel.invokeRoute('/x/sample-ts/hello', 'GET') as any).version, 1);
  healthy();
  while (kernel.status('sample-ts').version !== '2.0.0') await new Promise((done) => setTimeout(done, 5));
  assert.ok(!fixture.events.includes('1:stop'));
  const newResponse = await kernel.invokeRoute('/x/sample-ts/hello', 'GET') as any;
  assert.equal(newResponse.version, 2); assert.equal(newResponse.storage, services.extensionDataDir); assert.equal(newResponse.vault, true);
  finish(); assert.equal((await old as any).version, 1);
  assert.equal((await upgrade).upgraded, true); assert.ok(fixture.events.includes('1:stop'));
  assert.equal((await db.getExtensionInstall('sample-ts'))?.version, '2.0.0');
  assert.equal((await kernel.upgrade('sample-ts', versions.get(3)!)).upgraded, false);
  assert.ok(fixture.events.includes('3:stop')); assert.equal(kernel.status('sample-ts').version, '2.0.0');
  assert.equal((await kernel.invokeRoute('/x/sample-ts/hello', 'GET') as any).version, 2);
  await writeFile(join(versions.get(3)!, 'neo.extension.json'), '{bad json');
  assert.equal((await kernel.upgrade('sample-ts', versions.get(3)!)).upgraded, false);
  assert.equal(kernel.contributionIds().length, 1);
  console.log('PASS blue/green core: private staging, atomic route switch, old request drain, health/manifest rollback and stable storage/vault services');
} finally { finish(); healthy(); await kernel.close(); await rm(root, { recursive: true, force: true }); }
