import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VaultService } from '@neometaharness/vault';
import { PandaRouter } from '../src/router.js';
import { MODEL_ROLES } from '../../models/src/hub.js';
const home = await mkdtemp(join(tmpdir(), 'neo-panda-unit-'));
const secret = 'TEST_ONLY_PANDA_NEVER_LOG';
let mode = 'ok'; let calls = 0;
let arrived: (() => void) | undefined;
const server = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, `Bearer ${secret}`);
  if (req.url === '/health') { res.end(JSON.stringify({ ok: mode !== 'unhealthy' })); return; }
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(body.task.text.includes(secret), false);
  assert.ok(MODEL_ROLES.includes(body.task.kind_hint));
  assert.deepEqual(body.pool, [`panda-${body.task.kind_hint}`]); calls++;
  if (mode === 'hang') { arrived?.(); return; }
  if (mode === 'error') { res.writeHead(503).end(secret); return; }
  if (mode === 'invalid') { res.end('not-json'); return; }
  if (mode === 'large') { res.end('x'.repeat(70000)); return; }
  res.end(JSON.stringify({ choice: { model_id: mode === 'unknown' ? 'untrusted' : body.pool[0] } }));
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const config = { endpoint: `http://127.0.0.1:${address.port}`, vaultSecret: 'PANDA_API_KEY', timeoutMs: 100,
  roles: Object.fromEntries(MODEL_ROLES.map((role) => [role, [{ modelId: `panda-${role}`, providerId: 'chosen', model: role }]])) };
const direct = { providerId: 'direct', model: 'fallback' };
const vault = { get: async () => secret } as unknown as VaultService;
const router = new PandaRouter(vault, home);
try {
  await router.load(); assert.equal(router.settings(), null);
  assert.deepEqual(await router.health(), { ok: false, configured: false });
  await router.configure(config);
  for (const role of MODEL_ROLES) assert.deepEqual(await router.select(role, direct), { providerId: 'chosen', model: role });
  assert.equal(calls, 5); assert.equal((await router.health()).ok, true);
  mode = 'unhealthy'; assert.equal((await router.health()).ok, false);
  for (mode of ['error', 'invalid', 'large', 'unknown', 'hang']) assert.equal(await router.select('coding', direct), undefined, mode);
  await assert.rejects(router.configure({ ...config, endpoint: 'http://user:password@localhost' }));
  await assert.rejects(router.configure({ ...config, apiKey: secret }));
  await assert.rejects(router.configure({ ...config, roles: { coding: [config.roles.coding![0], config.roles.coding![0]] } }));
  assert.equal((await readFile(join(home, 'settings.json'), 'utf8')).includes(secret), false);
  const reloaded = new PandaRouter(vault, home); await reloaded.load();
  assert.deepEqual(reloaded.settings(), config); await reloaded.close();
  const missing = new PandaRouter({ get: async () => undefined } as unknown as VaultService, join(home, 'missing'));
  await missing.configure(config); assert.equal(await missing.select('coding', direct), undefined); await missing.close();
  mode = 'hang';
  const received = new Promise<void>((done) => { arrived = done; });
  const pending = router.select('coding', direct); await received;
  await router.close(); assert.equal(await pending, undefined);
  assert.equal(await router.select('coding', direct), undefined);
  console.log('PASS Panda HTTP adapter: five roles, vault-only key, persisted config, health, bounded failures and cancellation');
} finally {
  await router.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
  await rm(home, { recursive: true, force: true });
}
