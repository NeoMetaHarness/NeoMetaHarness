// P7-2 security regressions. Each test reproduces one finding from
// docs/security/review-2026-11.md through the real gateway HTTP surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { startGateway } from '../src/server.js';

type Gateway = Awaited<ReturnType<typeof startGateway>>;

async function withGateway(mode: 'desktop' | 'server', run: (gateway: Gateway, base: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'nmh-sec-p7-'));
  const extensionsDir = join(root, 'extensions');
  await mkdir(extensionsDir, { recursive: true });
  const gateway = await startGateway({ databaseFile: join(root, 'state/gateway.db'), extensionsDir, mode });
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
