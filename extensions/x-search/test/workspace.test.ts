import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startGateway } from '../../../apps/gateway/src/server.js';

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const home = await mkdtemp(join(tmpdir(), 'nmh-x-search-workspaces-'));
const keyA = 'FAKE_CORP_XAI_KEY';
const keyB = 'FAKE_FINANCE_XAI_KEY';
const seen: Array<{ key: string; query: string }> = [];
const fake = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString()) as { input: Array<{ content: string }> };
  seen.push({ key: String(req.headers.authorization), query: body.input[0]!.content });
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    output_text: 'isolated search', citations: [],
  }));
});
await new Promise<void>(done => fake.listen(0, '127.0.0.1', done));
const address = fake.address();
assert.ok(address && typeof address !== 'string');
const extensionsDir = join(home, 'extensions');
await mkdir(join(extensionsDir, 'x-search'), { recursive: true });
const manifest = JSON.parse(await readFile(join(repo, 'extensions/x-search/neo.extension.json'), 'utf8'));
manifest.runtime.entry = './index.mjs';
await writeFile(join(extensionsDir, 'x-search', 'neo.extension.json'), JSON.stringify(manifest));
await writeFile(join(extensionsDir, 'x-search', 'index.mjs'),
  `export { default } from ${JSON.stringify(pathToFileURL(join(repo, 'extensions/x-search/src/index.ts')).href)};`);
const gateway = await startGateway({
  databaseFile: join(home, 'gateway.db'), dataDir: join(home, 'data'), extensionsDir,
  mode: 'server', signup: 'open',
  searchHttpClient: { request: (url, init) => fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, init) },
});
const base = `http://127.0.0.1:${gateway.port}`;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const json = (input: unknown, token?: string) => ({
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? auth(token) : {}) },
  body: JSON.stringify(input),
});
async function rpc(token: string, path: string, input: unknown) {
  const response = await fetch(`${base}/${path}`, json({ json: input }, token));
  assert.equal(response.status, 200, path);
  return (await response.json() as { json: any }).json;
}
async function authPost(token: string, path: string, input: unknown) {
  const response = await fetch(`${base}/auth/${path}`, json(input, token));
  assert.equal(response.status, 200, path);
  return response.json() as Promise<any>;
}
try {
  const signUp = async (email: string) => {
    const response = await fetch(`${base}/auth/sign-up/email`, json({ email, password: 'Member!Pass123', name: 'Tester' }));
    assert.equal(response.status, 200, email);
    return (await response.json() as { token: string }).token;
  };
  const corpOwner = await signUp('corp@x-search.test');
  const corp = await authPost(corpOwner, 'organization/create', { name: 'Corp', slug: 'corp-x-search' });
  const finance = await authPost(corpOwner, 'organization/create',
    { name: 'Finance', slug: 'finance-x-search', keepCurrentActiveOrganization: true });
  const financeOwner = await signUp('finance@x-search.test');
  const invite = await authPost(corpOwner, 'organization/invite-member',
    { organizationId: finance.id, email: 'finance@x-search.test', role: 'admin' });
  await authPost(financeOwner, 'organization/accept-invitation', { invitationId: invite.id });
  await rpc(corpOwner, 'extensions/enable', { id: 'x-search' });
  await rpc(corpOwner, 'settings/set', { extension: 'x-search', values: { apiKey: keyA } });
  await rpc(financeOwner, 'settings/set', { extension: 'x-search', values: { apiKey: keyB } });
  assert.deepEqual((await rpc(corpOwner, 'settings/get', { extension: 'x-search' })).values.apiKey, { set: true });
  assert.deepEqual((await rpc(financeOwner, 'settings/get', { extension: 'x-search' })).values.apiKey, { set: true });
  const [corpResult, financeResult] = await Promise.all([
    rpc(corpOwner, 'x/x-search/search', { query: 'corp-query' }),
    rpc(financeOwner, 'x/x-search/search', { query: 'finance-query' }),
  ]);
  assert.equal(corpResult.text, 'isolated search');
  assert.equal(financeResult.text, 'isolated search');
  assert.deepEqual(seen.sort((a, b) => a.query.localeCompare(b.query)), [
    { key: `Bearer ${keyA}`, query: 'corp-query' },
    { key: `Bearer ${keyB}`, query: 'finance-query' },
  ]);
  assert.equal(await gateway.vault.get({ kind: 'engine', workspaceId: corp.id, subjectId: 'x-search' }, 'SEC_APIKEY'), keyA);
  assert.equal(await gateway.vault.get({ kind: 'engine', workspaceId: finance.id, subjectId: 'x-search' }, 'SEC_APIKEY'), keyB);
  await assert.rejects(gateway.kernel.invokeRoute('/x/x-search/search', 'RPC',
    { input: { query: 'missing identity' }, requester: { userId: 'background' } }), /workspace identity/);
  console.log('PASS P2-11 two workspace keys isolated across concurrent authenticated requests');
} finally {
  await gateway.close();
  fake.closeAllConnections();
  await new Promise<void>(done => fake.close(() => done()));
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

