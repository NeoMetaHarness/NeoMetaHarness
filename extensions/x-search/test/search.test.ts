import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { startGateway } from '../../../apps/gateway/src/server.js';
import { authorize } from '../../../apps/gateway/src/policy.js';
import { XSearchService } from '../src/index.js';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const home = await mkdtemp(join(tmpdir(), 'neo-x-search-'));
const apiKey = 'FAKE_XAI_KEY_FOR_TEST_9876';
const localRequester = { userId: 'test-user', workspaceId: 'test-workspace' };
const { validateEgressUrl } = await import('@neometaharness/egress');
assert.equal(validateEgressUrl('https://api.x.ai').host, 'api.x.ai');
assert.throws(() => validateEgressUrl('https://169.254.169.254'), /denied/);
assert.throws(() => validateEgressUrl('http://127.0.0.1', true), /HTTPS/);
let requestCount = 0;
let recordedBody: any;
let statusCode = 200;
const fake = createServer(async (req, res) => {
  assert.equal(req.url, '/v1/responses');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.authorization, `Bearer ${apiKey}`);
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  recordedBody = JSON.parse(Buffer.concat(chunks).toString());
  requestCount++;
  res.setHeader('content-type', 'application/json');
  if (statusCode !== 200) { res.writeHead(statusCode).end(apiKey); return; }
  res.end(JSON.stringify({
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'One cited result',
      annotations: [{ type: 'url_citation', url: 'https://x.com/xai/status/123' }] }] }],
    citations: ['https://x.com/xai/status/123'],
    usage: { server_side_tool_usage_details: { x_posts_fetched: 2, x_users_fetched: 1 } },
  }));
});

await new Promise<void>((done) => fake.listen(0, '127.0.0.1', done));
const address = fake.address();
assert.ok(address && typeof address !== 'string');
const endpoint = `http://127.0.0.1:${address.port}`;
const extensionsDir = join(home, 'extension-fixtures');
await mkdir(extensionsDir);
for (const id of ['x-search', 'sample-ts']) {
  const source = join(root, 'extensions', id);
  const manifest = JSON.parse(await readFile(join(source, 'neo.extension.json'), 'utf8'));
  manifest.runtime.entry = './index.mjs';
  await mkdir(join(extensionsDir, id));
  await writeFile(join(extensionsDir, id, 'neo.extension.json'), JSON.stringify(manifest));
  await writeFile(join(extensionsDir, id, 'index.mjs'),
    `export { default } from ${JSON.stringify(pathToFileURL(join(source, 'src', 'index.ts')).href)};`);
}

const options = {
  databaseFile: join(home, 'gateway.db'), dataDir: home, extensionsDir, mode: 'desktop' as const,
  searchHttpClient: {
    request: (_url: string, init: RequestInit) => fetch(`${endpoint}/v1/responses`, init),
  },
};
let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
function rpcClient(token?: string) {
  return createORPCClient<ContractRouterClient<typeof neoContract>>(new RPCLink({
    url: `http://127.0.0.1:${gateway!.port}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }));
}

const logged: string[] = [];
const originalOut = process.stdout.write;
const originalErr = process.stderr.write;
process.stdout.write = ((chunk: string | Uint8Array) => { logged.push(String(chunk)); return true; }) as typeof process.stdout.write;
process.stderr.write = ((chunk: string | Uint8Array) => { logged.push(String(chunk)); return true; }) as typeof process.stderr.write;

try {
  gateway = await startGateway(options);
  assert.ok(gateway.desktopToken);
  const rpc = rpcClient(gateway.desktopToken);
  await assert.rejects(rpcClient().x['x-search'].status(), (e: any) => e.code === 'UNAUTHORIZED');
  await assert.rejects(rpc.x['x-search'].search({ query: 'test' }), (e: any) => e.code === 'NOT_FOUND');

  const saved = await rpc.settings.set({ extension: 'x-search', values: {
    apiKey, baseUrl: 'https://api.x.ai', model: 'grok-4.7', allowPrivateNetwork: false,
    requestsPerMinutePerUser: 2, requestsPerMinutePerWorkspace: 2,
    requestsPerDayPerUser: 3, requestsPerDayPerWorkspace: 3,
  } });
  assert.deepEqual(saved.values.apiKey, { set: true });
  const settings = await rpc.settings.get({ extension: 'x-search' });
  assert.deepEqual(settings.values.apiKey, { set: true });
  assert.ok(!JSON.stringify(settings).includes(apiKey));

  assert.equal((await rpc.extensions.enable({ id: 'sample-ts' })).status, 'running');
  assert.equal((await rpc.extensions.enable({ id: 'x-search' })).status, 'running');
  await assert.rejects(new XSearchService({ apiKey, baseUrl: 'https://127.0.0.1' }).search({ query: 'blocked' }, localRequester), /denied/);
  await assert.rejects(new XSearchService({ apiKey, baseUrl: 'http://1.1.1.1', allowPrivateNetwork: true }, { request: async () => { throw new Error('unexpected fetch'); } }).search({ query: 'blocked' }, localRequester), /Invalid X Search endpoint configuration/);
  assert.deepEqual(await rpc.x['x-search'].status(), { providerId: 'xai', configured: true });
  assert.ok(gateway.kernel.contributionIds().includes('tools:x-search.search'));
  const result = await rpc.x['x-search'].search({
    query: 'What happened today?', allowedHandles: ['xai'], fromDate: '2026-11-01', toDate: '2026-11-20',
  });
  assert.deepEqual(result, {
    text: 'One cited result', citations: ['https://x.com/xai/status/123'],
    usage: { postsFetched: 2, usersFetched: 1 },
  });
  assert.equal(requestCount, 1);
  assert.deepEqual(recordedBody.tools, [{ type: 'x_search', allowed_x_handles: ['xai'], from_date: '2026-11-01', to_date: '2026-11-20' }]);
  assert.equal(recordedBody.model, 'grok-4.7');
  assert.equal(recordedBody.input[0].content, 'What happened today?');
  await assert.rejects(rpc.x['x-search'].search({ query: 'invalid date', fromDate: '2026-11-20', toDate: '2026-11-01' }));
  await assert.rejects(rpc.x['x-search'].search({ query: 'invalid calendar date', fromDate: '2026-99-99' }));
  await assert.rejects(rpc.x['x-search'].search({ query: 'invalid leap date', fromDate: '2026-02-29' }));
  assert.equal(requestCount, 1);
  statusCode = 429;
  await assert.rejects(rpc.x['x-search'].search({ query: 'rate limited' }), (e: any) =>
    e.code === 'INTERNAL_SERVER_ERROR' && !e.message.includes(apiKey));
  statusCode = 200;
  await assert.rejects(rpc.x['x-search'].search({ query: 'over user quota' }), (e: any) =>
    e.code === 'TOO_MANY_REQUESTS' && !e.message.includes(apiKey));
  assert.equal(requestCount, 2);
  assert.equal((await rpc.extensions.disable({ id: 'x-search' })).status, 'disabled');
  assert.equal((await rpc.extensions.enable({ id: 'x-search' })).status, 'running');
  await assert.rejects(rpc.x['x-search'].search({ query: 'quota persists after reactivation' }),
    (e: any) => e.code === 'TOO_MANY_REQUESTS');
  assert.equal(requestCount, 2);

  const injected = new XSearchService({ apiKey }, {
    request: async (url, request) => {
      assert.equal(url, 'https://api.x.ai/v1/responses');
      assert.equal(request.redirect, 'error');
      assert.equal((request.headers as Record<string, string>).authorization, `Bearer ${apiKey}`);
      throw new Error(`network failure ${apiKey}`);
    },
  });
  await assert.rejects(injected.search({ query: 'broken connection' }, localRequester), (e: Error) =>
    e.message === 'X Search request failed');

  const bounded = new XSearchService({ apiKey }, {
    request: async () => new Response(JSON.stringify({
      output_text: `${'a'.repeat(40_000)}${apiKey}`,
      citations: [
        'javascript:alert(1)', 'ftp://example.com/x', `https://x.com/${'b'.repeat(2100)}`,
        ...Array.from({ length: 36 }, (_, i) => `https://x.com/post/${i}`),
      ],
    }), { headers: { 'content-type': 'application/json' } }),
  });
  const boundedResult = await bounded.search({ query: 'bounded response' }, localRequester);
  assert.equal(boundedResult.text.length, 32_000);
  assert.equal(boundedResult.citations.length, 32);
  assert.ok(boundedResult.citations.every((url) => url.startsWith('https://')));
  assert.ok(!JSON.stringify(boundedResult).includes(apiKey));
  await assert.rejects(new XSearchService({ apiKey }, {
    request: async () => new Response('x'.repeat(1_000_001), {
      headers: { 'content-type': 'application/json' },
    }),
  }).search({ query: 'oversized response' }, localRequester), /invalid response|request failed/);
  await assert.rejects(bounded.search({ query: 'missing identity' }, { userId: '', workspaceId: 'test' }), /identity/);
  let now = Date.UTC(2026, 10, 21, 10);
  let meteredRequests = 0;
  const metered = new XSearchService({
    apiKey, requestsPerMinutePerUser: 2, requestsPerMinutePerWorkspace: 3,
    requestsPerDayPerUser: 3, requestsPerDayPerWorkspace: 5,
  }, {
    request: async () => {
      meteredRequests++;
      return new Response(JSON.stringify({ output_text: 'ok' }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  }, () => now);
  const alice = { userId: 'alice', workspaceId: 'team-1' };
  const bob = { userId: 'bob', workspaceId: 'team-1' };
  await metered.search({ query: 'one' }, alice);
  await metered.search({ query: 'two' }, alice);
  await assert.rejects(metered.search({ query: 'three' }, alice), /user minute/);
  const aliceElsewhere = { userId: 'alice', workspaceId: 'team-2' };
  await metered.search({ query: 'first in other workspace' }, aliceElsewhere);
  await metered.search({ query: 'second in other workspace' }, aliceElsewhere);
  await assert.rejects(metered.search({ query: 'other workspace user limit' }, aliceElsewhere), /user minute/);
  await metered.search({ query: 'bob' }, bob);
  await assert.rejects(metered.search({ query: 'workspace full' }, bob), /workspace minute/);
  now += 60_000;
  await metered.search({ query: 'alice again' }, alice);
  await assert.rejects(metered.search({ query: 'alice daily limit' }, alice), /user day/);
  await metered.search({ query: 'bob again' }, bob);
  await assert.rejects(metered.search({ query: 'workspace daily limit' }, bob), /workspace day/);
  assert.equal(meteredRequests, 7);
  now += 86_400_000;
  await metered.search({ query: 'new day' }, alice);
  assert.equal(meteredRequests, 8);
  const quotaFile = join(home, 'persisted-search-quotas.sqlite');
  const persistentSettings = {
    apiKey, requestsPerMinutePerUser: 2, requestsPerMinutePerWorkspace: 3,
    requestsPerDayPerUser: 3, requestsPerDayPerWorkspace: 5,
  };
  const persistentClient = {
    request: async () => new Response(JSON.stringify({ output_text: 'ok' }), {
      headers: { 'content-type': 'application/json' },
    }),
  };
  let persistent = new XSearchService(persistentSettings, persistentClient, () => now, quotaFile);
  await persistent.search({ query: 'first' }, alice);
  await persistent.search({ query: 'second' }, alice);
  persistent = new XSearchService(persistentSettings, persistentClient, () => now, quotaFile);
  await assert.rejects(persistent.search({ query: 'restart minute quota' }, alice), /user minute/);
  now += 60_000;
  await persistent.search({ query: 'third' }, alice);
  persistent = new XSearchService(persistentSettings, persistentClient, () => now, quotaFile);
  await assert.rejects(persistent.search({ query: 'restart daily quota' }, alice), /user day/);
  // A blue/green candidate starts before the serving generation's final charges.
  // Both must see the same durable counters after the candidate is published.
  const upgradeFile = join(home, 'upgrade-search-quotas.sqlite');
  const upgradeSettings = {
    ...persistentSettings,
    requestsPerMinutePerUser: 2,
  };
  const serving = new XSearchService(upgradeSettings, persistentClient, () => now, upgradeFile);
  const candidate = new XSearchService(upgradeSettings, persistentClient, () => now, upgradeFile);
  await serving.search({ query: 'serving after candidate activation' }, alice);
  await candidate.search({ query: 'candidate after publication' }, alice);
  await assert.rejects(serving.search({ query: 'old generation after publication' }, alice), /user minute/);
  const upgradeDb = new DatabaseSync(upgradeFile);
  const upgradeRow = upgradeDb.prepare('SELECT value FROM quota_state WHERE id = 1').get() as { value: string };
  const upgradeState = JSON.parse(upgradeRow.value);
  upgradeDb.close();
  assert.equal(upgradeState.users.find(([id]: [string]) => id === JSON.stringify([alice.workspaceId, alice.userId]))[1].minuteCount, 2);

  const concurrentFile = join(home, 'concurrent-search-quotas.sqlite');
  // Simulate a lock left by a crashed earlier generation. Two waiters must
  // proceed through SQLite's transaction lock without deleting the old lock.
  const abandonedLock = join(home, 'concurrent-search-quotas.json.lock');
  await writeFile(abandonedLock, 'abandoned-owner-token');
  const oldTime = new Date(Date.now() - 60_000);
  await utimes(abandonedLock, oldTime, oldTime);
  const concurrentSettings = { ...persistentSettings, requestsPerMinutePerUser: 1 };
  const first = new XSearchService(concurrentSettings, persistentClient, () => now, concurrentFile);
  const second = new XSearchService(concurrentSettings, persistentClient, () => now, concurrentFile);
  const concurrent = await Promise.allSettled([
    first.search({ query: 'simultaneous first' }, alice),
    second.search({ query: 'simultaneous second' }, alice),
  ]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter(result => result.status === 'rejected').length, 1);
  assert.equal(await readFile(abandonedLock, 'utf8'), 'abandoned-owner-token');
  const concurrentDb = new DatabaseSync(concurrentFile);
  const concurrentRow = concurrentDb.prepare('SELECT value FROM quota_state WHERE id = 1').get() as { value: string };
  assert.equal(JSON.parse(concurrentRow.value).users[0][1].minuteCount, 1);
  concurrentDb.close();

  // A legacy JSON snapshot is imported under the same database transaction.
  const migratedFile = join(home, 'migrated-search-quotas.sqlite');
  await writeFile(join(home, 'migrated-search-quotas.json'), JSON.stringify({
    day: Math.floor(now / 86_400_000),
    users: [[alice.userId, { minute: Math.floor(now / 60_000), minuteCount: 1, dayCount: 1 }]],
    workspaces: [[alice.workspaceId, { minute: Math.floor(now / 60_000), minuteCount: 1, dayCount: 1 }]],
  }));
  const migrated = new XSearchService(concurrentSettings, persistentClient, () => now, migratedFile);
  await assert.rejects(migrated.search({ query: 'legacy quota remains' }, alice), /user minute/);
  // A staged SQLite generation can charge while an older, still-draining
  // generation continues writing the legacy JSON store after the import.
  const lateFile = join(home, 'late-legacy-quotas.sqlite');
  const lateJson = lateFile.replace(/\.sqlite$/, '.json');
  const lateDay = Math.floor(now / 86_400_000);
  const lateMinute = Math.floor(now / 60_000);
  const oldSnapshot = (count: number) => JSON.stringify({
    day: lateDay,
    users: [[alice.userId, { minute: lateMinute, minuteCount: count, dayCount: count }]],
    workspaces: [[alice.workspaceId, { minute: lateMinute, minuteCount: count, dayCount: count }]],
  });
  await writeFile(lateJson, oldSnapshot(1));
  const nextGeneration = new XSearchService({
    ...persistentSettings, requestsPerMinutePerUser: 3, requestsPerMinutePerWorkspace: 3,
  }, persistentClient, () => now, lateFile);
  await nextGeneration.search({ query: 'sqlite migration starts' }, alice);
  await writeFile(lateJson, oldSnapshot(2)); // final legacy writer charge after SQLite began
  await assert.rejects(nextGeneration.search({ query: 'legacy late charge counted' }, alice), /user minute/);
  const migratedDb = new DatabaseSync(lateFile);
  const migratedRow = migratedDb.prepare('SELECT value FROM quota_state WHERE id = 1').get() as { value: string };
  assert.equal(JSON.parse(migratedRow.value).users[0][1].minuteCount, 3);
  migratedDb.close();
  await assert.rejects(nextGeneration.search({ query: 'legacy not double counted' }, alice), /user minute/);

  // A failed SQLite update rolls back reconciliation. On retry the legacy
  // delta must be applied exactly once, alongside that request's own charge.
  const rollbackFile = join(home, 'rollback-search-quotas.sqlite');
  const rollbackJson = rollbackFile.replace(/\.sqlite$/, '.json');
  await writeFile(rollbackJson, oldSnapshot(1));
  const rollbackService = new XSearchService({
    ...persistentSettings, requestsPerMinutePerUser: 8, requestsPerMinutePerWorkspace: 8,
    requestsPerDayPerUser: 8, requestsPerDayPerWorkspace: 8,
  }, persistentClient, () => now, rollbackFile);
  await rollbackService.search({ query: 'begin reconciliation' }, alice);
  await writeFile(rollbackJson, oldSnapshot(2));
  const rollbackDb = new DatabaseSync(rollbackFile);
  const rollbackCount = () => {
    const row = rollbackDb.prepare('SELECT value FROM quota_state WHERE id = 1').get() as { value: string };
    const state = JSON.parse(row.value);
    return state.users.find(([id]: [string]) => id === JSON.stringify([alice.workspaceId, alice.userId]))[1].dayCount;
  };
  rollbackDb.exec("CREATE TRIGGER fail_reconcile BEFORE UPDATE ON quota_state BEGIN SELECT RAISE(ABORT, 'forced rollback'); END");
  await assert.rejects(rollbackService.search({ query: 'rollback reconciliation' }, alice), /forced rollback/);
  assert.equal(rollbackCount(), 2);
  rollbackDb.exec('DROP TRIGGER fail_reconcile');
  await rollbackService.search({ query: 'reconcile after rollback' }, alice);
  assert.equal(rollbackCount(), 4);
  await rollbackService.search({ query: 'reconcile once only' }, alice);
  assert.equal(rollbackCount(), 5);
  rollbackDb.close();

  // An active write transaction must cause asynchronous retry. A scheduled
  // timer must run before we release it, proving the event loop stays live.
  const busyFile = join(home, 'busy-search-quotas.sqlite');
  const lockOwner = new DatabaseSync(busyFile);
  lockOwner.exec('CREATE TABLE quota_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  lockOwner.exec('BEGIN IMMEDIATE');
  let timerFired = false;
  const lockedRequest = new XSearchService(persistentSettings, persistentClient, () => now, busyFile)
    .search({ query: 'sqlite busy writer' }, alice);
  await new Promise<void>(resolve => setTimeout(() => { timerFired = true; resolve(); }, 40));
  assert.equal(timerFired, true);
  lockOwner.exec('COMMIT');
  lockOwner.close();
  await lockedRequest;

  // A writer that holds SQLite's lock past the five-second deadline must
  // refuse the request before it reaches the paid upstream or charges quota.
  const timeoutFile = join(home, 'timeout-search-quotas.sqlite');
  const timeoutOwner = new DatabaseSync(timeoutFile);
  timeoutOwner.exec('CREATE TABLE quota_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  timeoutOwner.exec('BEGIN IMMEDIATE');
  let timeoutUpstreamCalls = 0;
  const timeoutService = new XSearchService(persistentSettings, {
    request: async () => {
      timeoutUpstreamCalls++;
      return new Response(JSON.stringify({ output_text: 'ok' }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  }, () => now, timeoutFile);
  await assert.rejects(timeoutService.search({ query: 'locked past deadline' }, alice), /quota store is busy/);
  assert.equal(timeoutUpstreamCalls, 0);
  assert.equal(timeoutOwner.prepare('SELECT value FROM quota_state WHERE id = 1').get(), undefined);
  timeoutOwner.exec('COMMIT');
  timeoutOwner.close();
  await timeoutService.search({ query: 'after lock release' }, alice);
  assert.equal(timeoutUpstreamCalls, 1);
  const timeoutDb = new DatabaseSync(timeoutFile);
  const timeoutRow = timeoutDb.prepare('SELECT value FROM quota_state WHERE id = 1').get() as { value: string };
  assert.equal(JSON.parse(timeoutRow.value).users[0][1].dayCount, 1);
  timeoutDb.close();

  now += 86_400_000;
  await persistent.search({ query: 'next day' }, alice);
  const capped = new XSearchService({ apiKey, requestsPerMinutePerUser: 0, requestsPerDayPerUser: Infinity }, {
    request: async () => new Response(JSON.stringify({ output_text: 'ok' }), {
      headers: { 'content-type': 'application/json' },
    }),
  });
  for (let i = 0; i < 5; i++) await capped.search({ query: `fallback ${i}` }, localRequester);
  await assert.rejects(capped.search({ query: 'fallback exceeded' }, localRequester), /user minute/);
  const viewer = { user: { id: 'viewer' }, role: 'viewer', workspaceId: 'default' };
  assert.doesNotThrow(() => authorize('x.x-search.status', viewer as any));
  assert.throws(() => authorize('x.x-search.search', viewer as any), (e: any) => e.code === 'FORBIDDEN');
  assert.equal((await rpc.extensions.disable({ id: 'x-search' })).status, 'disabled');
  assert.ok(!gateway.kernel.contributionIds().includes('tools:x-search.search'));
  await assert.rejects(rpc.x['x-search'].search({ query: 'disabled' }), (e: any) => e.code === 'NOT_FOUND');
  assert.deepEqual(await gateway.kernel.invokeRoute('/x/sample-ts/hello', 'RPC'), { message: 'Hello from TypeScript' });
  assert.equal(requestCount, 2);
  assert.ok(!logged.join('\n').includes(apiKey));
} finally {
  process.stdout.write = originalOut;
  process.stderr.write = originalErr;
  await gateway?.close();
  fake.closeAllConnections();
  await new Promise<void>((done) => fake.close(() => done()));
  await rm(home, { recursive: true, force: true });
}
console.log('PASS P2-11 authenticated X Search, fake xAI Responses, vault secrecy, injected client, access control and disable isolation');
