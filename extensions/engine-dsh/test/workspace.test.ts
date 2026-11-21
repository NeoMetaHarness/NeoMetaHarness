// P1-13 review: in server mode a DSH session belongs to the workspace that created it. Another workspace that
// learns its id cannot prompt, follow, wait on, cancel or shut it down (and so cannot use its model keys).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { startGateway } from '../../../apps/gateway/src/server.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

const temp = await mkdtemp(join(tmpdir(), 'nmh-dsh-workspace-'));
const gateway = await startGateway({ databaseFile: join(temp, 'state/neo.sqlite'), extensionsDir: join(repo, 'extensions'),
  mode: 'server', signup: 'open' });
const base = `http://127.0.0.1:${gateway.port}`;
try {
  const signUp = async (email: string) => {
    const response = await fetch(`${base}/auth/sign-up/email`, json({ email, password: 'Member!Pass123', name: 'x' }));
    assert.equal(response.status, 200, email);
    return (await response.json() as { token: string }).token;
  };
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const corpOwner = await signUp('owner@corp.test');
  const corp = await (await fetch(`${base}/auth/organization/create`, json({ name: 'Corp', slug: 'corp' }, as(corpOwner)))).json() as { id: string };
  const finance = await (await fetch(`${base}/auth/organization/create`,
    json({ name: 'Finance', slug: 'finance', keepCurrentActiveOrganization: true }, as(corpOwner)))).json() as { id: string };
  const financeMember = await signUp('member@finance.test');
  const invite = await (await fetch(`${base}/auth/organization/invite-member`,
    json({ organizationId: finance.id, email: 'member@finance.test', role: 'member' }, as(corpOwner)))).json() as { id: string };
  assert.equal((await fetch(`${base}/auth/organization/accept-invitation`, json({ invitationId: invite.id }, as(financeMember)))).status, 200);
  const client = (token: string) => createORPCClient<ContractRouterClient<typeof neoContract>>(new RPCLink({ url: base, headers: () => as(token) }));
  const corpRpc = client(corpOwner);
  const financeRpc = client(financeMember);
  assert.equal((await corpRpc.extensions.enable({ id: 'engine-dsh' })).status, 'running');

  // Corp names Finance as the workspace; the Gateway stamps Corp's instead.
  const created = await corpRpc.x['engine-dsh'].create({ workspaceId: finance.id, cwd: temp });
  const sessionId = created.sessionId;
  const runtime = (gateway.kernel as any).snapshot.services.get('dshAgentRuntime');
  assert.equal(runtime.owners.get(sessionId), corp.id, 'the session belongs to the caller\'s workspace');

  const notFound = async (label: string, call: () => Promise<unknown>) => {
    await assert.rejects(call, (error: any) => error?.code === 'NOT_FOUND', label);
  };
  await notFound('prompt', () => financeRpc.x['engine-dsh'].prompt({ sessionId, text: 'use Corp keys' }));
  await notFound('events', async () => { for await (const _ of await financeRpc.x['engine-dsh'].events({ sessionId })) break; });
  await notFound('wait', () => financeRpc.x['engine-dsh'].wait({ sessionId }));
  await notFound('cancel', () => financeRpc.x['engine-dsh'].cancel({ sessionId }));
  await notFound('shutdown', () => financeRpc.x['engine-dsh'].shutdown({ sessionId }));
  await notFound('unknown id answers the same', () => financeRpc.x['engine-dsh'].wait({ sessionId: 'f'.repeat(32) }));

  // The owning workspace still reaches its session.
  assert.deepEqual(await corpRpc.x['engine-dsh'].shutdown({ sessionId }), { stopped: true });
  await notFound('a stopped session is gone', () => corpRpc.x['engine-dsh'].wait({ sessionId }));
  console.log('DSH_WORKSPACE PASS sessions are reachable only from the workspace that created them');
} finally {
  await gateway.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5 });
}
