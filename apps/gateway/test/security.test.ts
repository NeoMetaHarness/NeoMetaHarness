// P7-2 security regressions. Each test reproduces one finding from
// docs/security/review-2026-11.md through the real gateway HTTP surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { createORPCClient } from '@orpc/client';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { HermesProjector } from '@neometaharness/vault';
import { startGateway } from '../src/server.js';
import { HeadlessChromeProvider } from '../../../extensions/computer-headless-chrome/src/index.js';

type Gateway = Awaited<ReturnType<typeof startGateway>>;

async function withGateway(mode: 'desktop' | 'server', run: (gateway: Gateway, base: string) => Promise<void>,
  // Tests that predate SEC-08 sign up freely, so they opt into open sign-up explicitly.
  options: Partial<Parameters<typeof startGateway>[0]> = { signup: 'open' }) {
  const root = await mkdtemp(join(tmpdir(), 'nmh-sec-p7-'));
  const extensionsDir = join(root, 'extensions');
  await mkdir(extensionsDir, { recursive: true });
  const gateway = await startGateway({ databaseFile: join(root, 'state/gateway.db'), extensionsDir, mode, ...options });
  try {
    await run(gateway, `http://127.0.0.1:${gateway.port}`);
  } finally {
    await gateway.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

async function signUp(base: string, email: string): Promise<{ status: number; token?: string; userId?: string }> {
  const res = await fetch(`${base}/auth/sign-up/email`, json({ email, password: 'Attacker!Pass123', name: 'x' }));
  const body = res.ok ? await res.json() as { token?: string; user?: { id: string } } : {};
  return { status: res.status, token: body.token, userId: body.user?.id };
}

test('SEC-01: desktop mode refuses anonymous sign-up, so a loopback caller cannot mint an owner workspace', async () => {
  await withGateway('desktop', async (_gateway, base) => {
    const attacker = await signUp(base, 'mallory@evil.test');
    assert.notEqual(attacker.status, 200, 'desktop mode must not accept public sign-up');
    assert.equal(attacker.token, undefined);
    // Even with a forged token string nothing privileged is reachable.
    const res = await fetch(`${base}/extensions/disable`, json({ json: { id: 'sample-ts' } }, { authorization: 'Bearer forged' }));
    assert.equal(res.status, 401);
  });
});

test('SEC-02: once the instance has a workspace, a self-registered account cannot create one and gain owner authority', async () => {
  await withGateway('server', async (_gateway, base) => {
    const owner = await signUp(base, 'owner@corp.test');
    const first = await fetch(`${base}/auth/organization/create`,
      json({ name: 'Corp', slug: 'corp' }, { authorization: `Bearer ${owner.token}` }));
    assert.equal(first.status, 200, 'instance bootstrap may create the first workspace');
    const attacker = await signUp(base, 'mallory@evil.test');
    assert.equal(attacker.status, 200);
    const org = await fetch(`${base}/auth/organization/create`,
      json({ name: 'Mine', slug: 'mine' }, { authorization: `Bearer ${attacker.token}` }));
    assert.equal(org.status, 403, 'a roleless account must not self-create a workspace');
    const disable = await fetch(`${base}/extensions/disable`,
      json({ json: { id: 'sample-ts' } }, { authorization: `Bearer ${attacker.token}` }));
    assert.equal(disable.status, 403, 'a roleless account must not administer the gateway');
    const second = await fetch(`${base}/auth/organization/create`,
      json({ name: 'Corp B', slug: 'corp-b' }, { authorization: `Bearer ${owner.token}` }));
    assert.equal(second.status, 200, 'an existing owner may still create further workspaces');
  });
});

test('SEC-03: a user cannot mint an API key whose metadata claims a role they do not hold', async () => {
  await withGateway('server', async (_gateway, base) => {
    const attacker = await signUp(base, 'mallory@evil.test');
    const created = await fetch(`${base}/auth/api-key/create`, json(
      { name: 'x', metadata: { role: 'owner', workspaceId: 'default' } },
      { authorization: `Bearer ${attacker.token}` }));
    assert.equal(created.status, 200, 'precondition: Better Auth lets any session mint a key with metadata');
    const { key } = await created.json() as { key: string };
    const disable = await fetch(`${base}/extensions/disable`,
      json({ json: { id: 'sample-ts' } }, { 'x-api-key': key }));
    assert.equal(disable.status, 401, 'client-supplied API key metadata must never grant a role');
    const bearer = await fetch(`${base}/extensions/list`, json({ json: {} }, { authorization: `Bearer ${key}` }));
    assert.equal(bearer.status, 401, 'client-supplied API key metadata must never grant a role (Bearer form)');
  });
});

test('SEC-03b: an API key can narrow but never widen its owner\'s membership role', async () => {
  await withGateway('server', async (_gateway, base) => {
    const owner = await signUp(base, 'owner@corp.test');
    const org = await (await fetch(`${base}/auth/organization/create`,
      json({ name: 'Corp', slug: 'corp' }, { authorization: `Bearer ${owner.token}` }))).json() as { id: string };
    const viewer = await signUp(base, 'viewer@corp.test');
    const invite = await fetch(`${base}/auth/organization/add-member`, json(
      { organizationId: org.id, userId: viewer.userId, role: 'viewer' }, { authorization: `Bearer ${owner.token}` }));
    // add-member is server-only in Better Auth; fall back to the invitation flow if refused.
    if (!invite.ok) {
      const inv = await (await fetch(`${base}/auth/organization/invite-member`, json(
        { organizationId: org.id, email: 'viewer@corp.test', role: 'viewer' }, { authorization: `Bearer ${owner.token}` }))).json() as { id: string };
      const accepted = await fetch(`${base}/auth/organization/accept-invitation`, json(
        { invitationId: inv.id }, { authorization: `Bearer ${viewer.token}` }));
      assert.equal(accepted.status, 200, 'viewer joins the workspace');
    }
    const mint = async (token: string, role: string) => (await (await fetch(`${base}/auth/api-key/create`,
      json({ name: role, metadata: { role, workspaceId: org.id } }, { authorization: `Bearer ${token}` }))).json() as { key: string }).key;
    const narrowed = await mint(owner.token!, 'viewer');
    assert.equal((await fetch(`${base}/extensions/list`, json({ json: {} }, { 'x-api-key': narrowed }))).status, 200,
      'owner key narrowed to viewer may read');
    assert.equal((await fetch(`${base}/extensions/disable`, json({ json: { id: 'sample-ts' } }, { 'x-api-key': narrowed }))).status, 403,
      'owner key narrowed to viewer may not administer');
    const widened = await mint(viewer.token!, 'owner');
    assert.equal((await fetch(`${base}/extensions/disable`, json({ json: { id: 'sample-ts' } }, { 'x-api-key': widened }))).status, 403,
      'viewer key claiming owner is capped at viewer');
  });
});

function rawRequest(port: number, path: string, headers: Record<string, string>, body = ''): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET', headers }, (res) => {
      res.resume(); resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('SEC-04: requests carrying a non-loopback Host (DNS rebinding) or a foreign Origin are refused before any handler', async () => {
  await withGateway('server', async (gateway, base) => {
    const port = gateway.port;
    const signup = JSON.stringify({ email: 'rebind@evil.test', password: 'Attacker!Pass123', name: 'x' });
    const ct = { 'content-type': 'application/json' };
    assert.equal(await rawRequest(port, '/auth/sign-up/email', { ...ct, host: `rebind.evil.test:${port}` }, signup), 421,
      'a rebound hostname must not reach the auth API');
    assert.equal(await rawRequest(port, '/auth/sign-up/email', { ...ct, host: `127.0.0.1:${port}`, origin: 'https://evil.test' }, signup), 403,
      'a foreign Origin must not drive the auth API (CSRF check is disabled in Better Auth)');
    const ws = await rawRequest(port, '/ws', { host: `rebind.evil.test:${port}`, connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }).catch(() => 0);
    assert.notEqual(ws, 101, 'a rebound hostname must not open a WebSocket');
    // Legitimate loopback and app origins keep working.
    assert.equal(await rawRequest(port, '/auth/sign-up/email', { ...ct, host: `localhost:${port}`, origin: 'http://localhost:5173' }, signup), 200);
    assert.equal((await fetch(`${base}/auth/ok`)).status, 200);
  });
});

async function joinWorkspace(base: string, ownerToken: string, orgId: string, user: { userId?: string; token?: string }, email: string, role: string) {
  const inv = await (await fetch(`${base}/auth/organization/invite-member`, json(
    { organizationId: orgId, email, role }, { authorization: `Bearer ${ownerToken}` }))).json() as { id: string };
  const accepted = await fetch(`${base}/auth/organization/accept-invitation`, json(
    { invitationId: inv.id }, { authorization: `Bearer ${user.token}` }));
  assert.equal(accepted.status, 200, `${email} joins as ${role}`);
}

test('SEC-05: authorization runs before the extension-availability check for every role (no 404 shortcut)', async () => {
  // Empty extensions dir: models and engine-hermes are not loaded.
  await withGateway('server', async (_gateway, base) => {
    const owner = await signUp(base, 'owner@corp.test');
    const org = await (await fetch(`${base}/auth/organization/create`,
      json({ name: 'Corp', slug: 'corp' }, { authorization: `Bearer ${owner.token}` }))).json() as { id: string };
    const member = await signUp(base, 'member@corp.test');
    await joinWorkspace(base, owner.token!, org.id, member, 'member@corp.test', 'member');
    const as = (token: string) => ({ authorization: `Bearer ${token}` });
    // Admin-only route on a missing extension: a member is refused by policy, not told "not found".
    assert.equal((await fetch(`${base}/x/models/providers/delete`, json({ json: { id: 'openai' } }, as(member.token!)))).status, 403,
      'member hits policy before availability on an admin route');
    // A route the member may call reports the missing extension only after authorization.
    assert.equal((await fetch(`${base}/x/engine-hermes/profiles/create`, json({ json: { name: 'bot' } }, as(member.token!)))).status, 404,
      'authorized member learns the extension is unavailable');
    // Owner on a missing extension: authorized, then 404.
    assert.equal((await fetch(`${base}/x/models/providers/delete`, json({ json: { id: 'openai' } }, as(owner.token!)))).status, 404);
    // Unknown procedure under a known prefix is still 404 for an authenticated caller.
    assert.equal((await fetch(`${base}/x/engine-hermes/no-such-route`, json({ json: {} }, as(member.token!)))).status, 404);
  });
});

const vaultCall = (base: string, op: string, input: unknown, token: string) =>
  fetch(`${base}/vault/${op}`, json({ json: input }, { authorization: `Bearer ${token}` }));

test('SEC-07: owning one workspace grants no vault access to another workspace or to the legacy instance scope', async () => {
  await withGateway('server', async (_gateway, base) => {
    const owner = await signUp(base, 'owner@corp.test');
    const corp = await (await fetch(`${base}/auth/organization/create`,
      json({ name: 'Corp', slug: 'corp' }, { authorization: `Bearer ${owner.token}` }))).json() as { id: string };
    const finance = await (await fetch(`${base}/auth/organization/create`,
      json({ name: 'Finance', slug: 'finance', keepCurrentActiveOrganization: true }, { authorization: `Bearer ${owner.token}` }))).json() as { id: string };
    const admin = await signUp(base, 'admin@corp.test');
    await joinWorkspace(base, owner.token!, corp.id, admin, 'admin@corp.test', 'admin');
    // The deployment owner creates the side workspace and grants the Corp admin its owner role.
    const side = await fetch(`${base}/auth/organization/create`,
      json({ name: 'Side', slug: 'side', keepCurrentActiveOrganization: true }, { authorization: `Bearer ${owner.token}` }));
    assert.equal(side.status, 200);
    const sideWorkspace = await side.json() as { id: string };
    const invite = await fetch(`${base}/auth/organization/invite-member`, json({
      organizationId: sideWorkspace.id, email: 'admin@corp.test', role: 'owner',
    }, { authorization: `Bearer ${owner.token}` }));
    assert.equal(invite.status, 200);
    assert.equal((await fetch(`${base}/auth/organization/accept-invitation`, json({
      invitationId: (await invite.json() as { id: string }).id,
    }, { authorization: `Bearer ${admin.token}` }))).status, 200);
    const financeScope = { kind: 'workspace', workspaceId: finance.id };
    assert.equal((await vaultCall(base, 'put', { scope: financeScope, name: 'BANK_KEY', value: 'secret' }, owner.token!)).status, 200,
      'Finance owner may write Finance secrets');
    assert.equal((await vaultCall(base, 'list', { scope: financeScope }, admin.token!)).status, 403,
      'owner of an unrelated workspace must not list Finance secrets');
    assert.equal((await vaultCall(base, 'put', { scope: financeScope, name: 'BANK_KEY', value: 'evil' }, admin.token!)).status, 403,
      'owner of an unrelated workspace must not overwrite Finance secrets');
    const legacy = { kind: 'workspace', workspaceId: 'default' };
    assert.equal((await vaultCall(base, 'list', { scope: legacy }, admin.token!)).status, 403,
      'only the instance owner may use the legacy default scope');
    assert.equal((await vaultCall(base, 'put', { scope: legacy, name: 'HONCHO_URL', value: 'http://x' }, owner.token!)).status, 200,
      'the instance owner keeps the legacy default scope');
  });
});

test('SEC-08: server mode is invite-only by default; the first account needs the one-time setup token', async () => {
  await withGateway('server', async (gateway, base) => {
    const setupToken = (gateway as Gateway & { setupToken?: string }).setupToken;
    const body = (email: string) => JSON.stringify({ email, password: 'Attacker!Pass123', name: 'x' });
    const post = (email: string, headers: Record<string, string> = {}) => fetch(`${base}/auth/sign-up/email`,
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body(email) });
    assert.equal((await post('race@evil.test')).status, 403, 'first-come caller without the setup token must not bootstrap the instance');
    assert.equal((await post('race@evil.test', { 'x-neo-setup-token': 'f'.repeat(64) })).status, 403, 'a wrong setup token is refused');
    assert.ok(setupToken && /^[0-9a-f]{64}$/.test(setupToken), 'gateway exposes a 64-hex setup token while no account exists');
    const first = await post('owner@corp.test', { 'x-neo-setup-token': setupToken! });
    assert.equal(first.status, 200, 'the operator bootstraps with the setup token');
    assert.equal((await post('late@evil.test', { 'x-neo-setup-token': setupToken! })).status, 403, 'the setup token is single-use');
    const { token: ownerToken } = await first.json() as { token: string };
    const org = await (await fetch(`${base}/auth/organization/create`,
      json({ name: 'Corp', slug: 'corp' }, { authorization: `Bearer ${ownerToken}` }))).json() as { id: string };
    assert.equal((await post('stranger@evil.test')).status, 403, 'uninvited sign-up is refused');
    const invite = await fetch(`${base}/auth/organization/invite-member`, json(
      { organizationId: org.id, email: 'new@corp.test', role: 'member' }, { authorization: `Bearer ${ownerToken}` }));
    assert.equal(invite.status, 200);
    assert.equal((await post('new@corp.test')).status, 200, 'an invited email may sign up');
  }, { signup: undefined });
});


test('SEC-10: process extensions receive only an allowlisted environment, never gateway secrets', async () => {
  const leaked = { NMH_GATEWAY_TOKEN: 'leak-token', NEO_AUTH_SECRET: 'x'.repeat(40), OPENAI_API_KEY: 'sk-leak', NEO_EXT_PROBE_OK: 'not-declared' };
  const saved = Object.fromEntries(Object.keys(leaked).map((k) => [k, process.env[k]]));
  Object.assign(process.env, leaked);
  const root = await mkdtemp(join(tmpdir(), 'nmh-sec-env-'));
  const ext = join(root, 'extensions', 'env-probe');
  await mkdir(ext, { recursive: true });
  await copyFile(fileURLToPath(new URL('./fixtures/env-probe.mjs', import.meta.url)), join(ext, 'probe.mjs'));
  await writeFile(join(ext, 'neo.extension.json'), JSON.stringify({ id: 'env-probe', version: '0.1.0', displayName: 'Env probe',
    kind: ['feature'], runtime: { type: 'process', command: [process.execPath, 'probe.mjs'], protocol: 'jsonrpc' } }));
  const gateway = await startGateway({ databaseFile: join(root, 'state/gateway.db'), extensionsDir: join(root, 'extensions'), mode: 'desktop' });
  try {
    const base = `http://127.0.0.1:${gateway.port}`;
    const auth = { authorization: `Bearer ${gateway.desktopToken}` };
    const enabled = await fetch(`${base}/extensions/enable`, json({ json: { id: 'env-probe' } }, auth));
    assert.equal((await enabled.json() as { json: { status: string } }).json.status, 'running', 'probe extension starts');
    const res = await fetch(`${base}/x/env-probe/env`, { headers: auth });
    assert.equal(res.status, 200);
    const { names, hasPath } = await res.json() as { names: string[]; hasPath: boolean };
    assert.ok(hasPath, 'runtime essentials such as PATH still reach the extension');
    for (const key of Object.keys(leaked)) assert.ok(!names.includes(key), `${key} must not reach a process extension`);
  } finally {
    await gateway.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('SEC-11: the superagent bridge key expires, is swept after a crash, and never falls back to the master token', async () => {
  const { BridgeKey, BRIDGE_KEY_NAME, BRIDGE_KEY_TTL_SECONDS, BRIDGE_KEY_ROTATE_MS, bridgeEnv } =
    await import('../../../extensions/engine-superagent/src/bridge-key.js');
  await withGateway('desktop', async (gateway, base) => {
    const auth = gateway.auth as any;
    const owner = await auth.kysely.selectFrom('member').select(['userId']).where('role', '=', 'owner').executeTakeFirst();
    const probe = (key: string) => fetch(`${base}/extensions/list`, json({ json: {} }, { 'x-api-key': key }));
    // A key left behind by a crashed run.
    const stale = await auth.api.createApiKey({ body: { userId: owner.userId, name: BRIDGE_KEY_NAME,
      metadata: { role: 'member', workspaceId: (await auth.kysely.selectFrom('organization').select('id').executeTakeFirst()).id } } });
    assert.equal((await probe(stale.key)).status, 200, 'precondition: the stale key works');
    const bridge = new BridgeKey(auth);
    assert.ok(await bridge.sweep() >= 1);
    assert.equal((await probe(stale.key)).status, 401, 'crash leftovers are swept at activation');
    const minted = await bridge.mint();
    assert.ok(minted, 'a key is minted for the workspace owner');
    assert.equal((await probe(minted!.token)).status, 200);
    const row = await auth.kysely.selectFrom('apiKey').select(['expiresAt']).where('id', '=', minted!.id).executeTakeFirst();
    const ttl = new Date(row.expiresAt).getTime() - Date.now();
    assert.ok(ttl > 0 && ttl <= BRIDGE_KEY_TTL_SECONDS * 1000 + 60_000, 'the bridge key has a bounded expiry');
    assert.ok(BRIDGE_KEY_ROTATE_MS < BRIDGE_KEY_TTL_SECONDS * 1000 / 2, 'rotation runs well inside the key lifetime');
    await bridge.revoke(minted!.id);
    assert.equal((await probe(minted!.token)).status, 401, 'revoked keys stop working');
  });
  const saved = process.env.NMH_GATEWAY_TOKEN;
  process.env.NMH_GATEWAY_TOKEN = 'operator-master-token';
  try {
    const env = bridgeEnv('/home/dsh');
    assert.deepEqual(env, { DSH_HOME: '/home/dsh' }, 'without a minted key the bridge gets no credential at all');
    assert.ok(!Object.values(bridgeEnv('/home/dsh', '/x/bridge.token')).includes('operator-master-token'));
  } finally {
    if (saved === undefined) delete process.env.NMH_GATEWAY_TOKEN; else process.env.NMH_GATEWAY_TOKEN = saved;
  }
  const noOwner = new BridgeKey({ api: { createApiKey: async () => { throw new Error('must not mint'); } },
    kysely: { selectFrom: () => ({ select: () => ({ where: () => ({ orderBy: () => ({ executeTakeFirst: async () => undefined }) }) }) }) } });
  assert.equal(await noOwner.mint(), undefined, 'no owner yet means no key, and no fallback');
});

test('SEC-13: authorization runs before input validation on core routes, over HTTP and WebSocket', async () => {
  await withGateway('server', async (gateway, base) => {
    assert.equal((await signUp(base, 'owner@corp.test')).status, 200);
    const roleless = await signUp(base, 'roleless@evil.test');
    const as = { authorization: `Bearer ${roleless.token}` };
    // Malformed input from a caller with no role must be refused by policy, not described by the validator.
    for (const [route, body] of [['extensions/disable', { json: { wrong: 1 } }], ['vault/put', { json: { nope: true } }],
      ['agents/bots/create', { json: 42 }]] as const) {
      const res = await fetch(`${base}/${route}`, json(body, as));
      const text = await res.text();
      assert.equal(res.status, 403, `${route}: policy before validation`);
      assert.ok(!/Input validation failed|invalid_type/i.test(text), `${route}: no schema disclosure`);
    }
    const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`, [`bearer.${roleless.token}`]);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    try {
      const client = createORPCClient<any>(new WebSocketLink({ websocket: ws as any }));
      await assert.rejects(client.extensions.disable({ wrong: 1 }), (error: any) => error?.code === 'FORBIDDEN',
        'WS: policy before validation');
    } finally {
      ws.close();
    }
  });
});

test('SEC-15: the app sends its token only to a loopback gateway or the configured gateway origin', async () => {
  const g = globalThis as any;
  const saved = { window: g.window, localStorage: g.localStorage };
  const store = new Map([['neo_desktop_token', 'stored-owner-token']]);
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null };
  const at = (search: string) => { g.window = { location: { search, origin: 'https://app.neo.test' } }; };
  try {
    // Loaded by URL at runtime (tsx) so the gateway's typecheck doesn't compile the app's Vite-typed source.
    const { gatewayUrl, gatewayToken } = await import(new URL('../../neo-app/src/config.ts', import.meta.url).href) as {
      gatewayUrl: () => string; gatewayToken: () => string | null };
    at('?gateway=https%3A%2F%2Fevil.test');
    assert.notEqual(gatewayUrl(), 'https://evil.test', 'a foreign ?gateway= override is ignored');
    assert.match(gatewayUrl(), /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/, 'falls back to the configured loopback gateway');
    at('?gateway=http%3A%2F%2F127.0.0.1%3A5555');
    assert.equal(gatewayUrl(), 'http://127.0.0.1:5555', 'the Tauri shell may point at its loopback gateway');
    assert.equal(gatewayToken(), 'stored-owner-token', 'a loopback gateway receives the stored token');
    at('?gateway=http%3A%2F%2Flocalhost.evil.test%3A5555');
    assert.ok(!gatewayUrl().includes('evil'), 'look-alike hosts are not loopback');
  } finally {
    g.window = saved.window; g.localStorage = saved.localStorage;
  }
});

test('SEC-16: projected Hermes secrets reach python-dotenv byte-for-byte; unrepresentable ${...} is refused, never altered', async (t) => {
  const venv = fileURLToPath(new URL('../../../extensions/engine-hermes/.cache/venv/', import.meta.url));
  const python = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!existsSync(python)) { t.skip('Hermes venv not built yet (run the engine-hermes tests first)'); return; }
  const home = await mkdtemp(join(tmpdir(), 'nmh-sec-dotenv-'));
  try {
    // python-dotenv (and Hermes' env_loader) expand ${VAR} in every quoting style
    // with no escape, so such a value cannot be projected faithfully: refuse it.
    await assert.rejects(new HermesProjector(home).project(new Map([['OPENAI_API_KEY', 'sk-${HOME}']])),
      /\$\{/, 'a value python-dotenv would rewrite is refused');
    assert.ok(!existsSync(join(home, '.env')), 'nothing is written for a refused value');
    const tricky = 'sk-$OPENAI_API_KEY-$HOME-a\'b"c\\d#e f $';
    assert.ok(tricky.includes('\\'), 'precondition: the probe value contains a backslash');
    const secrets = new Map([['OPENAI_API_KEY', tricky], ['DEEPSEEK_API_KEY', 'plain-key_1.2']]);
    await new HermesProjector(home).project(secrets);
    const parsed = JSON.parse(execFileSync(python, ['-I', '-c',
      'import json,sys\nfrom dotenv import dotenv_values\nprint(json.dumps(dotenv_values(sys.argv[1])))', join(home, '.env')],
    { encoding: 'utf8' })) as Record<string, string>;
    assert.equal(parsed.OPENAI_API_KEY, tricky, 'python-dotenv must see the exact secret');
    assert.equal(parsed.DEEPSEEK_API_KEY, 'plain-key_1.2');
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

/** TCP ports in LISTEN state owned by `pid` or any of its descendants (null: no tool on this OS). */
function listeningPorts(pid: number): number[] | null {
  if (process.platform === 'win32') {
    const tree = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId; $ids = @(${pid}); ` +
      `do { $n = $ids.Count; $ids = @($ids + ($all | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object ProcessId)) | Sort-Object -Unique } while ($ids.Count -ne $n); $ids -join ','`,
    ], { encoding: 'utf8', windowsHide: true }).trim().split(',').map(Number);
    return execFileSync('netstat.exe', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols[3] === 'LISTENING' && tree.includes(Number(cols[4])))
      .map((cols) => Number(cols[1]!.split(':').at(-1)));
  }
  try {
    const out = execFileSync('ss', ['-Hltnp'], { encoding: 'utf8' });
    const tree = new Set([pid, ...execFileSync('ps', ['-e', '-o', 'pid=,ppid='], { encoding: 'utf8' })
      .trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number))
      .reduce<number[]>((acc, [child, parent]) => (acc.includes(parent!) || parent === pid ? [...acc, child!] : acc), [])]);
    return out.split('\n').filter((l) => [...l.matchAll(/pid=(\d+)/g)].some((m) => tree.has(Number(m[1]))))
      .map((l) => Number(l.trim().split(/\s+/)[3]!.split(':').at(-1)));
  } catch { return null; }
}

test('SEC-06: headless Chrome exposes no CDP TCP endpoint; only the in-process pipe can drive it', async (t) => {
  const chrome = process.env.NMH_CHROME ?? process.env.CHROME ??
    (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome');
  if (!existsSync(chrome)) { t.skip('Chrome not installed'); return; }
  const provider = new HeadlessChromeProvider();
  try {
    await provider.attach('sec06');
    const pid = provider.pid('sec06')!;
    const details = provider.browser('sec06') as { targetId?: string; send?: (method: string, params?: object, sessionId?: string) => Promise<any> };
    const ports = listeningPorts(pid);
    if (ports === null) t.diagnostic('no socket listing tool; port check skipped');
    else assert.deepEqual(ports, [], 'the Chrome process tree listens on no TCP port (no remote debugging port)');
    assert.doesNotMatch(JSON.stringify(details ?? {}), /(ws|http):\/\//, 'no network CDP endpoint is handed out');
    // The legitimate in-process channel still drives the browser.
    assert.equal(typeof details.send, 'function');
    const version = await details.send!('Browser.getVersion');
    assert.match(version.product, /Chrome/);
    const { sessionId } = await details.send!('Target.attachToTarget', { targetId: details.targetId, flatten: true });
    const result = await details.send!('Runtime.evaluate', { expression: '6*7', returnByValue: true }, sessionId);
    assert.equal(result.result.value, 42);
  } finally {
    await provider.dispose();
  }
});
