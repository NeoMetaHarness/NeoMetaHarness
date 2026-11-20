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
const { assertSafeProviderUrl, createSafeProviderClient } = await import('@neometaharness/kernel');
await assertSafeProviderUrl(new URL('https://provider.example'), { resolveHost: async () => ['8.8.8.8'] });
for (const blockedIp of ['127.0.0.1', '169.254.169.254', '10.0.0.8', '::1', 'fe80::1', '::ffff:127.0.0.1']) {
  await assert.rejects(assertSafeProviderUrl(new URL('https://provider.example'), { resolveHost: async () => [blockedIp] }), /Private provider endpoint is disabled/);
}
const poisonedOfficial = createSafeProviderClient({ resolveHost: async () => ['169.254.169.254'] });
try {
  await assert.rejects(poisonedOfficial.request('https://api.x.ai/v1/responses', { method: 'POST' }),
    /fetch failed|Private provider endpoint is disabled/);
} finally { await poisonedOfficial.close(); }
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

const options = { databaseFile: join(home, 'gateway.db'), dataDir: home, extensionsDir, mode: 'desktop' as const };
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

  const saved = await rpc.settings.set({ extension: 'x-search', values: { apiKey, baseUrl: endpoint, model: 'grok-4.7', allowPrivateNetwork: true } });
  assert.deepEqual(saved.values.apiKey, { set: true });
  const settings = await rpc.settings.get({ extension: 'x-search' });
  assert.deepEqual(settings.values.apiKey, { set: true });
  assert.ok(!JSON.stringify(settings).includes(apiKey));

  assert.equal((await rpc.extensions.enable({ id: 'sample-ts' })).status, 'running');
  assert.equal((await rpc.extensions.enable({ id: 'x-search' })).status, 'running');
  await assert.rejects(new XSearchService({ apiKey, baseUrl: endpoint }).search({ query: 'blocked' }), /Private provider endpoint is disabled/);
  await assert.rejects(new XSearchService({ apiKey, baseUrl: 'http://1.1.1.1' }, { request: async () => { throw new Error('unexpected fetch'); } }).search({ query: 'blocked' }), /Provider endpoint requires HTTPS/);
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
  assert.equal(requestCount, 1);
  statusCode = 429;
  await assert.rejects(rpc.x['x-search'].search({ query: 'rate limited' }), (e: any) =>
    e.code === 'INTERNAL_SERVER_ERROR' && !e.message.includes(apiKey));
  statusCode = 200;

  const injected = new XSearchService({ apiKey }, {
    request: async (url, request) => {
      assert.equal(url, 'https://api.x.ai/v1/responses');
      assert.equal(request.redirect, 'error');
      assert.equal((request.headers as Record<string, string>).authorization, `Bearer ${apiKey}`);
      throw new Error(`network failure ${apiKey}`);
    },
  });
  await assert.rejects(injected.search({ query: 'broken connection' }), (e: Error) =>
    e.message === 'X Search request failed');

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
