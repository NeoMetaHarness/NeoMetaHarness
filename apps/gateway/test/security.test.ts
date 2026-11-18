// P7-2 security regressions. Each test reproduces one finding from
// docs/security/review-2026-11.md through the real gateway HTTP surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    const key = created.ok ? (await created.json() as { key?: string }).key : undefined;
    if (key) {
      const disable = await fetch(`${base}/extensions/disable`,
        json({ json: { id: 'sample-ts' } }, { 'x-api-key': key }));
      assert.equal(disable.status, 401, 'client-supplied API key metadata must never grant a role');
      const bearer = await fetch(`${base}/extensions/list`, json({ json: {} }, { authorization: `Bearer ${key}` }));
      assert.equal(bearer.status, 401, 'client-supplied API key metadata must never grant a role (Bearer form)');
    }
  });
});
