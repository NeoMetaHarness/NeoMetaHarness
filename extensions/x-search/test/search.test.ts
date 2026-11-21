import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
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
  await assert.rejects(metered.search({ query: 'same user other workspace' }, {
    userId: 'alice', workspaceId: 'team-2',
  }), /user minute/);
  await metered.search({ query: 'bob' }, bob);
  await assert.rejects(metered.search({ query: 'workspace full' }, bob), /workspace minute/);
  now += 60_000;
  await metered.search({ query: 'alice again' }, alice);
  await assert.rejects(metered.search({ query: 'alice daily limit' }, alice), /user day/);
  await metered.search({ query: 'bob again' }, bob);
  await assert.rejects(metered.search({ query: 'workspace daily limit' }, bob), /workspace day/);
  assert.equal(meteredRequests, 5);
  now += 86_400_000;
  await metered.search({ query: 'new day' }, alice);
  assert.equal(meteredRequests, 6);
  const quotaFile = join(home, 'persisted-search-quotas.json');
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
  const upgradeFile = join(home, 'upgrade-search-quotas.json');
  const upgradeSettings = {
    ...persistentSettings,
    requestsPerMinutePerUser: 2,
  };
  const serving = new XSearchService(upgradeSettings, persistentClient, () => now, upgradeFile);
  const candidate = new XSearchService(upgradeSettings, persistentClient, () => now, upgradeFile);
  await serving.search({ query: 'serving after candidate activation' }, alice);
  await candidate.search({ query: 'candidate after publication' }, alice);
  await assert.rejects(serving.search({ query: 'old generation after publication' }, alice), /user minute/);
  const upgradeState = JSON.parse(await readFile(upgradeFile, 'utf8'));
  assert.equal(upgradeState.users.find(([id]: [string]) => id === alice.userId)[1].minuteCount, 2);

  const concurrentFile = join(home, 'concurrent-search-quotas.json');
  const concurrentSettings = { ...persistentSettings, requestsPerMinutePerUser: 1 };
  const first = new XSearchService(concurrentSettings, persistentClient, () => now, concurrentFile);
  const second = new XSearchService(concurrentSettings, persistentClient, () => now, concurrentFile);
  const concurrent = await Promise.allSettled([
    first.search({ query: 'simultaneous first' }, alice),
    second.search({ query: 'simultaneous second' }, alice),
  ]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter(result => result.status === 'rejected').length, 1);
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
