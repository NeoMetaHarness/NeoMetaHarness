// P6-10: the Inbox is scoped to the caller's workspace in server mode. Two workspaces, a fixture superagent
// that serves seeded items and records which actions reach it, and a Hermes-binding (channel) item that
// carries no workspace. Desktop behaviour is covered by the existing desktop suites (unchanged).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { startGateway } from '../src/server.js';

const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

// A stand-in for engine-superagent: the Gateway reaches it only through its /x/engine-superagent routes.
const superagentSrc = (file: string) => pathToFileURL(resolve(repo, 'extensions/engine-superagent/src', file)).href;
const FIXTURE = `
import { cronAsk } from '${superagentSrc('cron-source.ts')}';
import { dshReportItem } from '${superagentSrc('dsh-report.ts')}';
const items = new Map();
const actions = [];
const modes = {};
const now = Date.now();
const item = (id, workspace, status, extra = {}) => ({ id, text: id, botId: 'bot', mode: status === 'approval' ? 'act' : 'observe',
  status, ...(status === 'suggestion' ? { kind: 'suggestion' } : {}),
  ...(status === 'approval' ? { kind: 'approval', approval: { destructive: false, reason: 'ok?' } } : {}),
  ...(workspace ? { workspace } : {}), createdAt: now, updatedAt: now, ...extra });
export default { activate(ctx) {
  ctx.health(() => ({ ok: true }));
  ctx.route('test/seed', ({ body }) => {
    for (const [id, workspace, status, extra] of body.items) items.set(id, item(id, workspace, status, extra));
    return { ok: true };
  });
  ctx.route('test/actions', () => actions);
  ctx.route('list', () => [...items.values()]);
  const act = (name, status) => ({ body }) => { actions.push(name + ':' + body.id); const next = { ...items.get(body.id), status, kind: undefined }; items.set(body.id, next); return next; };
  ctx.route('accept', act('accept', 'running'));
  ctx.route('dismiss', act('dismiss', 'dismissed'));
  ctx.route('approval/decide', act('decide', 'ready'));
  ctx.route('ask', ({ body }) => { actions.push('ask:' + (body.workspace ?? '-')); const made = item('asked-' + actions.length, body.workspace, 'suggestion'); items.set(made.id, made); return made; });
  ctx.route('accept-mode/get', ({ body }) => ({ mode: modes[body.workspace] ?? 'observe' }));
  ctx.route('accept-mode/set', ({ body }) => { modes[body.workspace] = body.mode; return { mode: body.mode }; });
  ctx.route('reply', act('reply', 'running'));
  ctx.route('retry', act('retry', 'running'));
  // Decision records name their item (ticketId); the item text leaks through inputsSummary.
  const decision = (ticketId, at, workspace) => ({ trace_id: 't-' + ticketId, ticketId, ...(workspace ? { workspace } : {}), source: 'neo/app', inputsSummary: 'about ' + ticketId,
    candidates: [], chosenAction: 'dismiss', modelRole: 'eval', latencyMs: 0, outcome: 'dismissed', model_id: 'm',
    success: true, actual_latency_ms: 0, choice: { model_id: 'm' }, ranking: [], at });
  ctx.route('decisions/list', ({ body }) => [...items.values()].map((entry, index) => decision(entry.id, now + index, entry.workspace))
    .filter((entry) => (!body.ticketId || entry.ticketId === body.ticketId) && (body.workspace === undefined || entry.workspace === body.workspace)).reverse().slice(0, body.limit ?? 100));
  const jobs = new Map([['system-upstream', { id: 'system-upstream', text: '@neo/upstream check', botId: 'neo-system', schedule: '0 6 * * 1', mode: 'observe' }]]);
  ctx.route('cron/create', ({ body }) => { const job = { id: 'job-' + (jobs.size + 1), text: body.text, botId: body.botId,
    schedule: body.schedule, mode: body.mode ?? 'observe', ...(body.workspace ? { workspace: body.workspace } : {}) }; jobs.set(job.id, job); return job; });
  ctx.route('cron/list', () => [...jobs.values()]);
  // Firing uses the superagent's own cronAsk, so the item's workspace comes from the schedule, not the fixture.
  ctx.route('cron/fire', ({ body }) => { const ask = cronAsk(jobs.get(body.id)); const made = item('fired-' + body.id, ask.workspace, 'suggestion', { source: 'neo/cron', text: ask.text }); items.set(made.id, made); return { ok: true }; });
  ctx.route('test/dsh-report', ({ body }) => { const made = dshReportItem(body, 'dsh-' + body.sessionId, now); items.set(made.id, made); return { ok: true }; });
  ctx.route('cron/delete', ({ body }) => { actions.push('cron-delete:' + body.id); return { deleted: jobs.delete(body.id) }; });
  // Events: everything emitted so far, then new ones as they come, until the subscriber goes away.
  const log = []; const waiters = new Set();
  ctx.route('test/emit', ({ body }) => { log.push({ seq: log.length + 1, item: items.get(body.id) }); for (const wake of waiters) wake(); return { ok: true }; });
  ctx.route('events', ({ body }) => (async function* () {
    const signal = body.signal; let next = 0;
    while (!signal?.aborted) {
      while (next < log.length) yield log[next++];
      await new Promise((wake) => { const done = () => { waiters.delete(done); wake(); }; waiters.add(done); signal?.addEventListener('abort', done, { once: true }); });
    }
  })());
} };
`;

test('P6-10: Inbox items are listed and acted on only inside the caller workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nmh-p610-'));
  const extensions = join(root, 'extensions');
  await mkdir(join(extensions, 'engine-superagent', 'src'), { recursive: true });
  await writeFile(join(extensions, 'package.json'), '{"type":"module"}');
  await writeFile(join(extensions, 'engine-superagent', 'neo.extension.json'), JSON.stringify({ id: 'engine-superagent',
    version: '0.1.0', displayName: 'Inbox fixture', kind: ['engine'], runtime: { type: 'cordis', entry: './src/index.mjs' } }));
  await writeFile(join(extensions, 'engine-superagent', 'src', 'index.mjs'), FIXTURE);
  const gateway = await startGateway({ databaseFile: join(root, 'state/gateway.db'), extensionsDir: extensions,
    mode: 'server', signup: 'open' });
  const base = `http://127.0.0.1:${gateway.port}`;
  try {
    const signUp = async (email: string) => {
      const response = await fetch(`${base}/auth/sign-up/email`, json({ email, password: 'Member!Pass123', name: 'x' }));
      assert.equal(response.status, 200, email);
      return (await response.json() as { token: string }).token;
    };
    const as = (token: string) => ({ authorization: `Bearer ${token}` });
    const owner = await signUp('owner@corp.test');
    const corp = await (await fetch(`${base}/auth/organization/create`, json({ name: 'Corp', slug: 'corp' }, as(owner)))).json() as { id: string };
    const finance = await (await fetch(`${base}/auth/organization/create`,
      json({ name: 'Finance', slug: 'finance', keepCurrentActiveOrganization: true }, as(owner)))).json() as { id: string };
    const join_ = async (orgId: string, email: string, role: 'member' | 'viewer' = 'member') => {
      const token = await signUp(email);
      const invite = await (await fetch(`${base}/auth/organization/invite-member`,
        json({ organizationId: orgId, email, role }, as(owner)))).json() as { id: string };
      assert.equal((await fetch(`${base}/auth/organization/accept-invitation`, json({ invitationId: invite.id }, as(token)))).status, 200);
      return token;
    };
    const alice = await join_(corp.id, 'alice@corp.test');
    const bob = await join_(finance.id, 'bob@finance.test');
    const carol = await join_(corp.id, 'carol@corp.test', 'viewer');
    assert.equal((await fetch(`${base}/extensions/enable`, json({ json: { id: 'engine-superagent' } }, as(owner)))).status, 200);
    const call = async (token: string, path: string, input: unknown) => {
      const response = await fetch(`${base}/${path}`, json({ json: input }, as(token)));
      return { status: response.status, body: response.ok ? (await response.json() as { json: any }).json : undefined };
    };
    const fixture = (route: string, body: unknown = {}) => gateway.kernel.invokeRoute(`/x/engine-superagent/${route}`, 'RPC', body);
    await fixture('test/seed', { items: [
      ['corp-suggestion', corp.id, 'suggestion'], ['corp-approval', corp.id, 'approval'], ['corp-dismiss', corp.id, 'suggestion'],
      ['finance-suggestion', finance.id, 'suggestion'], ['finance-approval', finance.id, 'approval'],
      ['corp-question', corp.id, 'question'], ['corp-failed', corp.id, 'failed'],
      ['corp-destructive', corp.id, 'approval', { approval: { destructive: true, reason: 'deletes memory' } }],
      // An unstamped Hermes channel binding belongs to the deployment.
      ['hermes-binding', undefined, 'suggestion', { source: 'neo/channel' }],
      ['upstream-bump', undefined, 'suggestion', { source: 'neo/upstream' }],
    ] });
    const ids = async (token: string) => ((await call(token, 'inbox/list', {})).body as { id: string }[]).map((item) => item.id).sort();

    // list: each workspace sees only its own items; the workspace-less binding is in neither.
    const corpItems = ['corp-approval', 'corp-destructive', 'corp-dismiss', 'corp-failed', 'corp-question', 'corp-suggestion'];
    assert.deepEqual(await ids(alice), corpItems);
    assert.deepEqual(await ids(carol), corpItems, 'a viewer still reads their workspace');
    assert.deepEqual(await ids(bob), ['finance-approval', 'finance-suggestion']);
    assert.deepEqual(await ids(owner), [...corpItems, 'hermes-binding', 'upstream-bump'], 'the deployment owner sees both scopes');

    // accept / dismiss / decide on another workspace's item (or the binding) is 404 and never reaches the superagent.
    for (const [path, input] of [
      ['inbox/accept', { id: 'corp-suggestion' }], ['inbox/dismiss', { id: 'corp-dismiss' }],
      ['inbox/approval/decide', { id: 'corp-approval', decision: 'approve', reason: 'mine now' }],
      ['inbox/accept', { id: 'hermes-binding' }], ['inbox/dismiss', { id: 'hermes-binding' }],
      ['inbox/accept', { id: 'no-such-item' }],
      ['inbox/reply', { id: 'corp-question', answer: 'from Finance' }], ['inbox/retry', { id: 'corp-failed' }],
    ] as const) assert.equal((await call(bob, path, input)).status, 404, `Finance member reaches ${input.id} through ${path}`);
    // A viewer of the right workspace is refused by role (403).
    for (const [path, input] of [
      ['inbox/accept', { id: 'corp-suggestion' }], ['inbox/dismiss', { id: 'corp-dismiss' }],
      ['inbox/approval/decide', { id: 'corp-approval', decision: 'approve', reason: 'viewer' }],
    ] as const) assert.equal((await call(carol, path, input)).status, 403, `viewer acts through ${path}`);
    // A member is refused their own workspace's destructive approval (admin or owner only).
    assert.equal((await call(alice, 'inbox/approval/decide', { id: 'corp-destructive', decision: 'approve', reason: 'member' })).status, 403);
    assert.deepEqual(await fixture('test/actions'), [], 'no refused action reached the superagent');

    // Members act on their own workspace's items.
    assert.equal((await call(alice, 'inbox/accept', { id: 'corp-suggestion' })).status, 200);
    assert.equal((await call(alice, 'inbox/dismiss', { id: 'corp-dismiss' })).status, 200);
    assert.equal((await call(alice, 'inbox/approval/decide', { id: 'corp-approval', decision: 'approve', reason: 'ok' })).status, 200);
    assert.equal((await call(bob, 'inbox/accept', { id: 'finance-suggestion' })).status, 200);
    assert.equal((await call(alice, 'inbox/reply', { id: 'corp-question', answer: 'Fridays' })).status, 200);
    assert.equal((await call(alice, 'inbox/retry', { id: 'corp-failed' })).status, 200);
    for (const id of ['hermes-binding', 'upstream-bump']) {
      assert.equal((await call(alice, 'inbox/accept', { id })).status, 404);
      assert.equal((await call(owner, 'inbox/accept', { id })).status, 200);
    }
    assert.deepEqual(await fixture('test/actions'), ['accept:corp-suggestion', 'dismiss:corp-dismiss', 'decide:corp-approval',
      'accept:finance-suggestion', 'reply:corp-question', 'retry:corp-failed', 'accept:hermes-binding', 'accept:upstream-bump']);

    // New items are stamped with the caller's workspace by the Gateway, whatever the caller sends.
    const asked = await call(bob, 'inbox/ask', { text: 'Close the books', botId: 'bot', workspace: corp.id });
    assert.equal(asked.status, 200);
    assert.equal(asked.body.workspace, finance.id);
    assert.ok((await ids(bob)).includes(asked.body.id));
    assert.ok(!(await ids(alice)).includes(asked.body.id));
    console.log('P6-10_INBOX PASS workspace isolation and deployment-owner visibility');

    // The accept mode is per workspace too (owner's active workspace is Corp).
    assert.equal((await call(owner, 'inbox/acceptMode/set', { mode: 'act' })).status, 200);
    assert.equal((await call(alice, 'inbox/acceptMode/get', {})).body.mode, 'act');
    assert.equal((await call(bob, 'inbox/acceptMode/get', {})).body.mode, 'observe', 'Corp\'s accept mode does not reach Finance');
    console.log('P6-10_ACCEPT_MODE PASS accept mode is keyed by the caller workspace');

    // Decision records follow their item's workspace.
    const tickets = async (token: string, input: Record<string, unknown> = {}) =>
      ((await call(token, 'inbox/decisions/list', input)).body as { ticketId: string }[]).map((entry) => entry.ticketId).sort();
    assert.deepEqual(await tickets(bob), [asked.body.id, 'finance-approval', 'finance-suggestion'].sort());
    assert.deepEqual(await tickets(bob, { ticketId: 'corp-suggestion' }), [], 'naming another workspace\'s ticket finds nothing');
    assert.deepEqual(await tickets(alice), corpItems);
    assert.ok(!(await tickets(owner)).some((id) => id === 'hermes-binding' || id === 'upstream-bump'), 'no deployment-level decisions');
    assert.equal((await tickets(alice, { limit: 2 })).length, 2, 'the limit applies after scoping');
    console.log('P6-10_DECISIONS PASS decision records are scoped to the caller workspace');

    // Schedules: created in the caller's workspace, listed and deleted only there; the system schedule is the owner's.
    const corpJob = await call(alice, 'inbox/cron/create', { text: 'Weekly report', botId: 'bot', schedule: '0 9 * * 1' });
    assert.equal(corpJob.status, 200);
    assert.equal(corpJob.body.workspace, corp.id, 'a schedule carries its creator\'s workspace');
    const financeJob = await call(bob, 'inbox/cron/create', { text: 'Month end', botId: 'bot', schedule: '0 9 1 * *' });
    const jobs = async (token: string) => ((await call(token, 'inbox/cron/list', {})).body as { id: string }[]).map((job) => job.id).sort();
    assert.deepEqual(await jobs(alice), [corpJob.body.id]);
    assert.deepEqual(await jobs(carol), [corpJob.body.id], 'viewers list their workspace\'s schedules');
    assert.deepEqual(await jobs(bob), [financeJob.body.id]);
    assert.deepEqual(await jobs(owner), [corpJob.body.id, 'system-upstream'].sort(), 'the system upstream schedule is deployment-level');
    assert.equal((await call(bob, 'inbox/cron/delete', { id: corpJob.body.id })).status, 404);
    assert.equal((await call(alice, 'inbox/cron/delete', { id: 'system-upstream' })).status, 404);
    // A fired schedule's item carries the schedule's workspace (the superagent's cronAsk), end to end.
    const savedEnv = process.env.NODE_ENV; process.env.NODE_ENV = 'test';
    try {
      assert.equal((await call(owner, 'inbox/cron/fire', { id: corpJob.body.id })).status, 200);
      assert.equal((await call(owner, 'inbox/cron/fire', { id: financeJob.body.id })).status, 404, 'firing another workspace\'s schedule is 404');
    } finally { if (savedEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedEnv; }
    assert.ok((await ids(alice)).includes('fired-' + corpJob.body.id));
    assert.ok(!(await ids(bob)).includes('fired-' + corpJob.body.id));
    assert.equal(((await call(alice, 'inbox/list', {})).body as { id: string; workspace?: string }[])
      .find((entry) => entry.id === 'fired-' + corpJob.body.id)!.workspace, corp.id);
    // A DSH report belongs to its session's workspace (the superagent's dshReportItem).
    await fixture('test/dsh-report', { sessionId: 's1', workspaceId: finance.id, profile: 'p', turn: 't', status: 'ready', summary: 'done', question: 'Q' });
    assert.ok((await ids(bob)).includes('dsh-s1'));
    assert.ok(!(await ids(alice)).includes('dsh-s1'));
    assert.equal((await call(alice, 'inbox/cron/delete', { id: corpJob.body.id })).status, 200);
    assert.deepEqual((await fixture('test/actions') as string[]).filter((entry) => entry.startsWith('cron-delete')), ['cron-delete:' + corpJob.body.id]);
    console.log('P6-10_CRON PASS schedules are created, listed and deleted only in the caller workspace');

    // Events: a subscriber hears only its workspace's items, and a removed member's stream ends.
    const listen = (token: string) => {
      const client = createORPCClient<ContractRouterClient<typeof neoContract>>(new RPCLink({ url: base, headers: () => as(token) }));
      const controller = new AbortController();
      const heard: string[] = [];
      const done = (async () => {
        try { for await (const event of await client.inbox.events({}, { signal: controller.signal })) heard.push(event.item.id); }
        catch (error) { if (!controller.signal.aborted) throw error; }
      })();
      return { heard, done, stop: () => controller.abort() };
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
    const aliceEvents = listen(alice); const bobEvents = listen(bob); const ownerEvents = listen(owner);
    await settle();
    for (const id of ['corp-suggestion', 'finance-suggestion', 'hermes-binding', 'upstream-bump']) await fixture('test/emit', { id });
    await settle();
    assert.deepEqual(aliceEvents.heard, ['corp-suggestion']);
    assert.deepEqual(bobEvents.heard, ['finance-suggestion']);
    assert.deepEqual(ownerEvents.heard, ['corp-suggestion', 'hermes-binding', 'upstream-bump']);
    // Bob leaves Finance: after the next membership re-check his stream stops delivering and ends.
    const removed = await fetch(`${base}/auth/organization/remove-member`, json({ memberIdOrEmail: 'bob@finance.test', organizationId: finance.id }, as(owner)));
    assert.equal(removed.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    await fixture('test/emit', { id: 'finance-approval' });
    await settle();
    assert.deepEqual(bobEvents.heard, ['finance-suggestion'], 'a removed member hears nothing more');
    await Promise.race([bobEvents.done, new Promise((_, reject) => setTimeout(() => reject(new Error('stream still open')), 3_000))]);
    aliceEvents.stop(); ownerEvents.stop();
    await Promise.all([aliceEvents.done, ownerEvents.done]);
    console.log('P6-10_EVENTS PASS events stay in the caller workspace; removed members stop receiving');
  } finally {
    await gateway.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('P6-10: a transferred deployment owner loses visibility on an existing stream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nmh-p610-deploy-'));
  const extensions = join(root, 'extensions');
  await mkdir(join(extensions, 'engine-superagent', 'src'), { recursive: true });
  await writeFile(join(extensions, 'package.json'), '{"type":"module"}');
  await writeFile(join(extensions, 'engine-superagent', 'neo.extension.json'), JSON.stringify({ id: 'engine-superagent',
    version: '0.1.0', displayName: 'Inbox fixture', kind: ['engine'], runtime: { type: 'cordis', entry: './src/index.mjs' } }));
  await writeFile(join(extensions, 'engine-superagent', 'src', 'index.mjs'), FIXTURE);
  const gateway = await startGateway({ databaseFile: join(root, 'state/gateway.db'), extensionsDir: extensions,
    mode: 'server', signup: 'open' });
  const base = `http://127.0.0.1:${gateway.port}`;
  try {
    const signUp = async (email: string) => (await (await fetch(`${base}/auth/sign-up/email`,
      json({ email, password: 'Member!Pass123', name: 'x' }))).json() as { token: string }).token;
    const as = (token: string) => ({ authorization: `Bearer ${token}` });
    const founder = await signUp('founder@corp.test');
    const corp = await (await fetch(`${base}/auth/organization/create`, json({ name: 'Corp', slug: 'corp' }, as(founder)))).json() as { id: string };
    const dave = await signUp('dave@corp.test');
    const invite = await (await fetch(`${base}/auth/organization/invite-member`,
      json({ organizationId: corp.id, email: 'dave@corp.test', role: 'owner' }, as(founder)))).json() as { id: string };
    assert.equal((await fetch(`${base}/auth/organization/accept-invitation`, json({ invitationId: invite.id }, as(dave)))).status, 200);
    assert.equal((await fetch(`${base}/extensions/enable`, json({ json: { id: 'engine-superagent' } }, as(founder)))).status, 200);
    const fixture = (route: string, body: unknown = {}) => gateway.kernel.invokeRoute(`/x/engine-superagent/${route}`, 'RPC', body);
    await fixture('test/seed', { items: [['upstream-bump', undefined, 'suggestion', { source: 'neo/upstream' }],
      ['hermes-binding', undefined, 'suggestion', { source: 'neo/channel' }]] });
    const ids = async (token: string) => ((await (await fetch(`${base}/inbox/list`, json({ json: {} }, as(token)))).json() as { json: { id: string }[] })
      .json.map((item) => item.id).sort());
    assert.deepEqual(await ids(dave), [], 'workspace ownership does not expose deployment items');
    const client = createORPCClient<ContractRouterClient<typeof neoContract>>(new RPCLink({ url: base, headers: () => as(founder) }));
    const controller = new AbortController();
    const heard: string[] = [];
    const done = (async () => {
      try { for await (const event of await client.inbox.events({}, { signal: controller.signal })) heard.push(event.item.id); }
      catch (error) { if (!controller.signal.aborted) throw error; }
    })();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fixture('test/emit', { id: 'upstream-bump' });
    await fixture('test/emit', { id: 'hermes-binding' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(heard, ['upstream-bump', 'hermes-binding']);
    const daveUser = await gateway.auth.kysely.selectFrom('user').select('id').where('email', '=', 'dave@corp.test').executeTakeFirstOrThrow();
    await client.system.transferDeploymentOwner({ userId: daveUser.id });
    assert.deepEqual(await ids(founder), [], 'the former deployment owner retains only workspace visibility');
    assert.deepEqual(await ids(dave), ['hermes-binding', 'upstream-bump']);
    await fixture('test/emit', { id: 'upstream-bump' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(heard, ['upstream-bump', 'hermes-binding'], 'an open stream loses deployment visibility immediately');
    controller.abort();
    await Promise.race([done, new Promise((wait) => setTimeout(wait, 1_000))]);
    console.log('P6-10_DEPLOYMENT PASS open streams re-check deployment ownership after transfer');
  } finally {
    await gateway.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('P6-10: desktop keeps its old answers for unknown schedules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nmh-p610-desktop-'));
  const extensions = join(root, 'extensions');
  await mkdir(join(extensions, 'engine-superagent', 'src'), { recursive: true });
  await writeFile(join(extensions, 'package.json'), '{"type":"module"}');
  await writeFile(join(extensions, 'engine-superagent', 'neo.extension.json'), JSON.stringify({ id: 'engine-superagent',
    version: '0.1.0', displayName: 'Inbox fixture', kind: ['engine'], runtime: { type: 'cordis', entry: './src/index.mjs' } }));
  await writeFile(join(extensions, 'engine-superagent', 'src', 'index.mjs'), FIXTURE);
  const gateway = await startGateway({ databaseFile: join(root, 'state/gateway.db'), dataDir: join(root, 'data'),
    extensionsDir: extensions, mode: 'desktop' });
  try {
    const headers = { authorization: `Bearer ${gateway.desktopToken}` };
    const base = `http://127.0.0.1:${gateway.port}`;
    assert.equal((await fetch(`${base}/extensions/enable`, json({ json: { id: 'engine-superagent' } }, headers))).status, 200);
    const removed = await fetch(`${base}/inbox/cron/delete`, json({ json: { id: 'no-such-job' } }, headers));
    assert.equal(removed.status, 200, 'desktop does not 404 an unknown schedule');
    assert.deepEqual((await removed.json() as { json: unknown }).json, { deleted: false });
    console.log('P6-10_DESKTOP PASS unknown schedules answer { deleted: false } on desktop as before');
  } finally {
    await gateway.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
