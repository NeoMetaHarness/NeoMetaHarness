import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGateway } from '../src/server.js';

const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const request = (body: unknown, token: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});

test('P4-10 standing intents are administered by workspace admins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nmh-p4-10-'));
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  try {
    gateway = await startGateway({ databaseFile: join(root, 'gateway.db'),
      extensionsDir: join(repo, 'extensions'), mode: 'server', signup: 'open' });
    const base = `http://127.0.0.1:${gateway.port}`;
    const signup = async (email: string) => {
      const response = await fetch(`${base}/auth/sign-up/email`, {
        ...request({ email, password: 'Pass!1234567', name: email }, ''),
        headers: { 'content-type': 'application/json' },
      });
      assert.equal(response.status, 200);
      return (await response.json() as { token: string }).token;
    };
    const call = async (token: string, path: string, input: unknown) => {
      const response = await fetch(`${base}/${path}`, request({ json: input }, token));
      return { status: response.status,
        body: response.ok ? (await response.json() as { json: any }).json : null };
    };

    const owner = await signup('owner@p410.test');
    const member = await signup('member@p410.test');
    const admin = await signup('admin@p410.test');
    const organizationResponse = await fetch(`${base}/auth/organization/create`,
      request({ name: 'P4-10 team', slug: 'p410team' }, owner));
    assert.equal(organizationResponse.status, 200);
    const organization = await organizationResponse.json() as { id: string };

    for (const [email, token, role] of [
      ['member@p410.test', member, 'member'],
      ['admin@p410.test', admin, 'admin'],
    ] as const) {
      const invite = await fetch(`${base}/auth/organization/invite-member`,
        request({ organizationId: organization.id, email, role }, owner));
      assert.equal(invite.status, 200);
      const { id } = await invite.json() as { id: string };
      const accepted = await fetch(`${base}/auth/organization/accept-invitation`,
        request({ invitationId: id }, token));
      assert.equal(accepted.status, 200);
    }

    assert.equal((await call(owner, 'extensions/enable', { id: 'memory-local' })).status, 200);
    const path = (action: string) => `x/memory-local/intents/${action}`;
    const intents = async () => {
      const response = await call(member, path('list'), {});
      assert.equal(response.status, 200, 'member can list intents');
      return response.body as Array<{ id: string; text: string }>;
    };

    assert.equal((await call(member, path('add'), { text: 'Unauthorized intent' })).status, 403);
    assert.deepEqual(await intents(), [], 'rejected create did not write');

    const created = await call(admin, path('add'), { text: 'Answer precisely.' });
    assert.equal(created.status, 200, 'workspace admin can create');
    assert.deepEqual((await intents()).map(({ text }) => text), ['Answer precisely.']);

    assert.equal((await call(member, path('update'), { id: created.body.id, text: 'Malicious change' })).status, 403);
    assert.deepEqual((await intents()).map(({ text }) => text), ['Answer precisely.'], 'rejected update did not write');

    const updated = await call(admin, path('update'), { id: created.body.id, text: 'Answer in English.' });
    assert.equal(updated.status, 200, 'workspace admin can update');
    assert.equal(updated.body.text, 'Answer in English.');
    assert.deepEqual((await intents()).map(({ text }) => text), ['Answer in English.']);

    assert.equal((await call(member, path('retract'), { id: created.body.id })).status, 403);
    assert.deepEqual((await intents()).map(({ text }) => text), ['Answer in English.'], 'rejected delete did not write');

    const removed = await call(admin, path('retract'), { id: created.body.id });
    assert.equal(removed.status, 200, 'workspace admin can delete');
    assert.equal(removed.body.retracted, true);
    assert.deepEqual(await intents(), []);
    console.log('P4-10 PASS member_write_403=true no_member_writes=true admin_crud=true member_list=true');
  } finally {
    await gateway?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
