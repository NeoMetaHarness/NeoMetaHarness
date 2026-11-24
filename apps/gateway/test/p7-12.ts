import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startGateway } from '../src/server.js';

const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const rpcInput = (json: unknown, authorization?: string) => ({ method: 'POST',
  headers: { 'content-type': 'application/json', ...(authorization ? { authorization: `Bearer ${authorization}` } : {}) },
  body: JSON.stringify({ json }),
});

test('P7-12 metrics route is authenticated, workspace-isolated and toggle-safe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nmh-p712-'));
  const extensionRoot = join(root, 'extensions');
  const data = join(root, 'state', 'extensions');
  const write = async (file: string, content: unknown) => {
    const path = join(root, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
  };
  const metricsSource = pathToFileURL(join(repo, 'extensions', 'metrics', 'src', 'index.ts')).href;
  await write('extensions/package.json', '{"type":"module"}');
  await write('extensions/metrics/neo.extension.json', {
    id: 'metrics', version: '0.1.0', displayName: 'Metrics', kind: ['tool'],
    runtime: { type: 'cordis', entry: './src/index.mjs' },
  });
  await write('extensions/metrics/src/index.mjs', `export { default } from '${metricsSource}';`);
  await write('extensions/fake-superagent/neo.extension.json', {
    id: 'fake-superagent', version: '0.1.0', displayName: 'Fake superagent metrics', kind: ['tool'],
    runtime: { type: 'cordis', entry: './src/index.mjs' },
  });
  await write('extensions/fake-superagent/src/index.mjs', `
    import { readFileSync } from 'node:fs';
    export default { activate(ctx) {
      ctx.provide('superagentMetrics', {
        inbox: () => JSON.parse(readFileSync(${JSON.stringify(join(data, 'engine-superagent', 'inbox.json'))}, 'utf8')),
        decisions: async () => [],
      });
      ctx.health(() => ({ ok: true }));
    } };
  `);
  await write('extensions/healthy/neo.extension.json', {
    id: 'healthy', version: '0.1.0', displayName: 'Healthy', kind: ['tool'],
    runtime: { type: 'cordis', entry: './src/index.mjs' },
  });
  await write('extensions/healthy/src/index.mjs', 'export default { activate(ctx) { ctx.route("ping", () => ({ ok: true })); ctx.health(() => ({ ok: true })); } };');

  const gateway = await startGateway({ databaseFile: join(root, 'state', 'gateway.db'),
    extensionsDir: extensionRoot, mode: 'server', signup: 'open' });
  const base = `http://127.0.0.1:${gateway.port}`;
  const post = async (path: string, body: unknown, token?: string) => fetch(`${base}/${path}`, rpcInput(body, token));
  try {
    const signup = async (email: string) => {
      const response = await fetch(`${base}/auth/sign-up/email`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'Member!Pass123', name: email }) });
      assert.equal(response.status, 200, email);
      return (await response.json() as { token: string }).token;
    };
    const organization = async (token: string, name: string) => {
      const response = await fetch(`${base}/auth/organization/create`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name, slug: name.toLowerCase(), keepCurrentActiveOrganization: true }) });
      assert.equal(response.status, 200);
      return (await response.json() as { id: string }).id;
    };
    const ownerA = await signup('metric-a@example.test');
    const orgA = await organization(ownerA, 'MetricA');
    const orgB = await organization(ownerA, 'MetricB');
    const ownerB = await signup('metric-b@example.test');
    const inviteB = await fetch(`${base}/auth/organization/invite-member`, { method: 'POST',
      headers: { authorization: `Bearer ${ownerA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: orgB, email: 'metric-b@example.test', role: 'admin' }) });
    assert.equal(inviteB.status, 200);
    const inviteBId = (await inviteB.json() as { id: string }).id;
    assert.equal((await fetch(`${base}/auth/organization/accept-invitation`, { method: 'POST',
      headers: { authorization: `Bearer ${ownerB}`, 'content-type': 'application/json' },
      body: JSON.stringify({ invitationId: inviteBId }) })).status, 200);
    const setActive = async (token: string, organizationId: string) => {
      const response = await fetch(`${base}/auth/organization/set-active`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId }) });
      assert.equal(response.status, 200, 'select the invited organization');
      const sessionResponse = await fetch(`${base}/auth/get-session`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const session = await sessionResponse.json() as { session: { activeOrganizationId: string } };
      assert.equal(session.session.activeOrganizationId, organizationId, 'selected workspace persisted');
    };
    await setActive(ownerB, orgB);
    const member = await signup('metric-member@example.test');
    const invite = await fetch(`${base}/auth/organization/invite-member`, { method: 'POST',
      headers: { authorization: `Bearer ${ownerA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: orgA, email: 'metric-member@example.test', role: 'member' }) });
    assert.equal(invite.status, 200);
    const inviteId = (await invite.json() as { id: string }).id;
    const accepted = await fetch(`${base}/auth/organization/accept-invitation`, { method: 'POST',
      headers: { authorization: `Bearer ${member}`, 'content-type': 'application/json' },
      body: JSON.stringify({ invitationId: inviteId }) });
    assert.equal(accepted.status, 200);
    await setActive(member, orgA);

    const inbox = (id: string, workspace?: string) => ({ id, workspace, text: id, botId: 'neo',
      mode: 'observe', status: 'ready', createdAt: 1, updatedAt: 2,
      episode: { goal: id, steps: [], tools: [], outcome: 'ready', traceId: `trace-${id}` } });
    await mkdir(data, { recursive: true });
    await write('state/extensions/engine-superagent/inbox.json', [inbox('a1', orgA), inbox('a2', orgA), inbox('b1', orgB), inbox('global')]);
    await write('state/extensions/engine-superagent/traces/decisions.jsonl', [
      { ticketId: 'a1', workspace: orgA, chosenAction: 'ticket.complete', trace_id: 'trace-a1' },
      { ticketId: 'b1', workspace: orgB, chosenAction: 'ticket.complete', trace_id: 'trace-b1' },
    ].map((line) => JSON.stringify(line)).join('\n'));

    assert.equal((await post('extensions/enable', { id: 'fake-superagent' }, ownerA)).status, 200);
    assert.equal((await post('extensions/enable', { id: 'metrics' }, ownerA)).status, 200);
    assert.equal((await post('extensions/enable', { id: 'healthy' }, ownerA)).status, 200);
    const summary = async (token: string, query = '') => {
      const response = await post(`x/metrics/summary${query}`, {}, token);
      const body = response.ok ? await response.json() as { json?: any } : null;
      return { status: response.status, value: body?.json ?? body };
    };
    const memberSummary = await summary(member);
    assert.equal(memberSummary.status, 403, 'a member cannot read metrics');
    assert.equal((await post('x/metrics/summary', {})).status, 401, 'anonymous calls are refused');
    const a = await summary(ownerA);
    const b = await summary(ownerB);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.value.completedTickets, 2);
    assert.equal(b.value.completedTickets, 1);
    assert.equal(a.value.learning.qualifiedSkills, null, 'deployment-wide skill records are private');
    assert.equal((await summary(ownerA, `?workspace=${orgB}`)).value.completedTickets, 2,
      'query strings cannot supply or change the caller workspace');

    assert.equal((await post('extensions/disable', { id: 'fake-superagent' }, ownerA)).status, 200);
    const unavailable = await summary(ownerA);
    assert.equal(unavailable.status, 200);
    assert.equal(unavailable.value.finishedTickets, null);
    assert.equal(unavailable.value.completedTickets, null);
    assert.equal(unavailable.value.attention.withRecordedApproval, null);
    assert.match(unavailable.value.attention.reason, /engine-superagent is not installed, or is missing or disabled/i);

    assert.equal((await post('extensions/disable', { id: 'metrics' }, ownerA)).status, 200);
    assert.equal((await summary(ownerA)).status, 404);
    assert.deepEqual(await gateway.kernel.invokeRoute('/x/healthy/ping', 'RPC', {}), { ok: true });
    assert.deepEqual(await gateway.kernel.health('healthy'), { ok: true });
    console.log('P7-12_GATEWAY PASS authentication, server workspaces, disabled route and healthy peer');
  } finally {
    await gateway.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
