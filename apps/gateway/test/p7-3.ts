import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import type { neoContract } from '@neometaharness/contracts';
import { restrictPrivatePath } from '@neometaharness/vault';
import { startGateway, type GatewayInstance } from '../src/server.js';
import { verifyArchive } from '../../../extensions/backup/src/archive.js';

const exec = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const root = await mkdtemp(join(tmpdir(), 'neo-p73-'));
const source = join(root, 'original'), restored = join(root, 'restored'), installed = join(root, 'installed');
const passphrase = 'isolated P7-3 archive passphrase';
const passFile = join(root, 'passphrase.txt');
const archive = join(root, 'backup.neo');
let gateway: GatewayInstance | undefined;
const client = (token?: string) => createORPCClient<ContractRouterClient<typeof neoContract>>(new RPCLink({
  url: `http://127.0.0.1:${gateway!.port}`, headers: token ? { authorization: `Bearer ${token}` } : {},
}));
const removeTestDir = async (path: string) => {
  assert.ok(resolve(path).startsWith(resolve(root) + '/') || resolve(path).startsWith(resolve(root) + '\\'));
  await rm(path, { recursive: true, force: true });
};
const previousEnv = { NODE_ENV: process.env.NODE_ENV, NMH_HERMES_HOME: process.env.NMH_HERMES_HOME,
  NMH_SUPERAGENT_TEST_ADAPTER: process.env.NMH_SUPERAGENT_TEST_ADAPTER };
try {
  process.env.NODE_ENV = 'test';
  process.env.NMH_HERMES_HOME = join(root, 'personal-hermes');
  process.env.NMH_SUPERAGENT_TEST_ADAPTER = pathToFileURL(join(repo, 'extensions/engine-superagent/test/scripted-models.ts')).href;
  await mkdir(installed);
  await writeFile(join(installed, 'package.json'), '{"type":"module"}');
  for (const id of ['backup', 'memory-local', 'skills-registry', 'engine-superagent', 'engine-dsh', 'engine-t3', 'sample-ts']) {
    const manifest = JSON.parse(await readFile(join(repo, 'extensions', id, 'neo.extension.json'), 'utf8'));
    await mkdir(join(installed, id, 'src'), { recursive: true });
    await writeFile(join(installed, id, 'neo.extension.json'), JSON.stringify({ ...manifest, runtime: { type: 'cordis', entry: './src/index.ts' } }));
    await writeFile(join(installed, id, 'src/index.ts'), `export { default } from ${JSON.stringify(pathToFileURL(join(repo, 'extensions', id, manifest.runtime.entry)).href)};`);
  }
  // Bot storage needs an enabled runtime; this fixture never calls a real Hermes account.
  await mkdir(join(installed, 'engine-hermes', 'src'), { recursive: true });
  await writeFile(join(installed, 'engine-hermes', 'neo.extension.json'), JSON.stringify({ id: 'engine-hermes', version: '0.1.0', displayName: 'Scripted Hermes fixture', runtime: { type: 'cordis', entry: './src/index.ts' } }));
  await writeFile(join(installed, 'engine-hermes', 'src/index.ts'), 'export default { activate(ctx) { ctx.health(() => ({ok:true})); } };');
  await mkdir(process.env.NMH_HERMES_HOME);
  await writeFile(join(process.env.NMH_HERMES_HOME, 'personal.txt'), 'personal home untouched');
  await writeFile(passFile, passphrase, { mode: 0o600 });
  gateway = await startGateway({ databaseFile: join(source, 'neo.sqlite'), dataDir: source, extensionsDir: installed, mode: 'desktop' });
  let rpc = client(gateway.desktopToken);
  for (const status of gateway.kernel.list()) await rpc.extensions.enable({ id: status.id });
  for (const status of gateway.kernel.list()) assert.equal(status.status, 'running', `${status.id}: ${status.reason}`);
  const bot = await rpc.agents.bots.create({ name: 'Recovered drill bot' });
  const memory = await rpc.x['memory-local'].add({ workspace: 'default', subject: 'bot', subjectId: bot.id, text: 'Remember the restore drill', source: 'manual', provenance: 'P7-3', trust: 'confirmed' });
  const skill = { name: 'restore-skill', sourceProfile: 'bot-a', sourcePath: 'SKILL.md', content: '---\nname: restore-skill\n---\nDrill v1' };
  await rpc.x['skills-registry'].import(skill);
  const v2Content = '---\nname: restore-skill\n---\nDrill v2';
  const v2 = await rpc.x['skills-registry'].import({ ...skill, content: v2Content });
  assert.equal(v2.version, 2);
  const versions = await rpc.x['skills-registry'].versions({ name: v2.name });
  const scope = { kind: 'workspace' as const, workspaceId: 'default' };
  await rpc.vault.put({ scope, name: 'DRILL_SECRET', value: 'decrypted only with separately retained master key' });
  const inbox = await rpc.inbox.ask({ botId: bot.id, text: 'Keep this restore drill proposal', mode: 'observe' });
  assert.equal(inbox.status, 'suggestion');
  for (const [name, content] of [['engine-dsh/session/home/proof.txt', 'Neo DSH home'], ['engine-hermes/home/proof.txt', 'Neo Hermes home'], ['engine-superagent/traces/drill.json', '{"drill":true}']]) {
    const filename = join(source, 'extensions', name); await mkdir(dirname(filename), { recursive: true }); await writeFile(filename, content);
  }
  const input = { out: archive, passphrase };
  await assert.rejects(client().system.backup(input), (e: any) => e.code === 'UNAUTHORIZED');
  for (const role of ['viewer', 'member', 'admin']) {
    for (const name of ['backup', 'restore']) {
      const handler = (gateway.router as any).system[name]['~orpc'].handler;
      await assert.rejects(handler({ input: undefined, context: { user: { id: 'not-owner' }, role } }), (e: any) => e.code === 'FORBIDDEN');
    }
  }
  const backup = await rpc.system.backup(input);
  assert.ok(backup.files > 5);
  const verified = await verifyArchive(archive, passphrase);
  assert.ok(verified.manifest.versions['upstream:deepseek-harness']);
  assert.equal(verified.manifest.versions.backup, '0.1.0');
  assert.ok(verified.files.some(f => f.path.includes('/.git/')));
  assert.ok(!verified.files.some(f => /master\.key|vault-keys|personal\.txt|node_modules|\/\.cache\//.test(f.path)));
  const sqlite = Buffer.from(verified.files.find(f => f.path === 'neo.sqlite')!.content, 'base64');
  assert.ok(!sqlite.includes(Buffer.from('decrypted only with separately retained master key')));
  await assert.rejects(rpc.system.restore({ archive, dataDir: source, passphrase, force: true }), /protected/);
  const routeCopy = join(root, 'route-copy');
  await rpc.system.restore({ archive, dataDir: routeCopy, passphrase, force: false });
  await access(join(routeCopy, 'neo.sqlite'));
  await exec(process.execPath, ['--import', 'tsx', 'src/backup-cli.ts', '--out', join(root, 'cli.neo')], {
    cwd: join(repo, 'apps/gateway'), windowsHide: true, env: { ...process.env,
      NEO_GATEWAY_URL: `http://127.0.0.1:${gateway.port}`, NEO_GATEWAY_TOKEN: gateway.desktopToken!, NEO_BACKUP_PASSPHRASE_FILE: passFile },
  });
  await gateway.kernel.disable('backup');
  await assert.rejects(rpc.system.backup({ ...input, out: join(root, 'disabled.neo') }), (e: any) => e.code === 'NOT_FOUND');
  assert.ok((await rpc.agents.bots.list()).some(b => b.id === bot.id));
  await gateway.kernel.enable('backup');
  const retainedKey = join(root, 'secure-key', 'master.key');
  await mkdir(dirname(retainedKey));
  await restrictPrivatePath(dirname(retainedKey));
  await writeFile(retainedKey, await readFile(join(source, 'vault-keys/master.key')));
  await restrictPrivatePath(retainedKey);
  await gateway.close(); gateway = undefined;
  await removeTestDir(source);
  await assert.rejects(access(source));
  await exec(process.execPath, ['--import', 'tsx', 'src/restore-cli.ts', '--archive', archive, '--data-dir', restored], {
    cwd: join(repo, 'apps/gateway'), windowsHide: true, env: { ...process.env, NEO_BACKUP_PASSPHRASE_FILE: passFile },
  });
  gateway = await startGateway({ databaseFile: join(restored, 'neo.sqlite'), dataDir: restored, extensionsDir: installed,
    mode: 'desktop', vaultKeyFile: retainedKey });
  rpc = client(gateway.desktopToken);
  assert.ok((await rpc.agents.bots.list()).some(b => b.id === bot.id && b.name === bot.name));
  assert.ok((await rpc.x['memory-local'].list({ workspace: 'default', query: '' })).some(m => m.id === memory.id && m.text === memory.text));
  assert.equal((await rpc.x['skills-registry'].get({ name: v2.name })).content, v2Content);
  assert.deepEqual(await rpc.x['skills-registry'].versions({ name: v2.name }), versions);
  assert.match((await rpc.x['skills-registry'].diff({ name: v2.name, from: 1, to: 2 })).diff, /Drill v2/);
  assert.equal(await gateway.vault.get(scope, 'DRILL_SECRET'), 'decrypted only with separately retained master key');
  const recovered = (await rpc.inbox.list()).find(item => item.id === inbox.id);
  assert.equal(recovered?.text, inbox.text);
  assert.equal(recovered?.status, 'blocked');
  assert.match(recovered?.report?.summary ?? '', /restarted/);
  assert.equal(await readFile(join(restored, 'extensions/engine-dsh/session/home/proof.txt'), 'utf8'), 'Neo DSH home');
  assert.equal(await readFile(join(restored, 'extensions/engine-hermes/home/proof.txt'), 'utf8'), 'Neo Hermes home');
  assert.equal(await readFile(join(restored, 'extensions/engine-superagent/traces/drill.json'), 'utf8'), '{"drill":true}');
  assert.equal(await readFile(join(process.env.NMH_HERMES_HOME, 'personal.txt'), 'utf8'), 'personal home untouched');
  const bytes = await readFile(archive); bytes[bytes.length - 1] ^= 1;
  const tampered = join(root, 'tampered.neo'); await writeFile(tampered, bytes);
  const rejected = join(root, 'must-not-exist');
  await assert.rejects(rpc.system.restore({ archive: tampered, dataDir: rejected, passphrase, force: false }), /authentication/);
  await assert.rejects(access(rejected));
  console.log('P7-3 PASS authenticated=true wiped=true fresh-boot=true bot=true memory=true registry-v2+git-history=true vault-decrypt=true key-excluded=true inbox-recovered=true engine-homes+traces=true cli=true owner-only=true disabled-healthy=true tamper-rejected=true');
} finally {
  await gateway?.close();
  for (const [name, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '/') || resolve(root).startsWith(resolve(tmpdir()) + '\\'));
  await rm(root, { recursive: true, force: true });
}
