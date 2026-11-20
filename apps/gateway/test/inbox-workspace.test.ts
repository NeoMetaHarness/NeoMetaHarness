// P6-10: the Inbox is scoped to the caller's workspace in server mode. Two workspaces, a fixture superagent
// that serves seeded items and records which actions reach it, and a Hermes-binding (channel) item that
// carries no workspace. Desktop behaviour is covered by the existing desktop suites (unchanged).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGateway } from '../src/server.js';

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

// A stand-in for engine-superagent: the Gateway reaches it only through its /x/engine-superagent routes.
const FIXTURE = `
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
      // A Hermes channel binding reaches the Inbox with no workspace: no workspace member may see or act on it.
      ['hermes-binding', undefined, 'suggestion', { source: 'neo/channel' }],
    ] });
    const ids = async (token: string) => ((await call(token, 'inbox/list', {})).body as { id: string }[]).map((item) => item.id).sort();

    // list: each workspace sees only its own items; the workspace-less binding is in neither.
    assert.deepEqual(await ids(alice), ['corp-approval', 'corp-dismiss', 'corp-suggestion']);
    assert.deepEqual(await ids(carol), ['corp-approval', 'corp-dismiss', 'corp-suggestion'], 'a viewer still reads their workspace');
    assert.deepEqual(await ids(bob), ['finance-approval', 'finance-suggestion']);
    assert.ok(!(await ids(owner)).includes('hermes-binding'));

    // accept / dismiss / decide on another workspace's item (or the binding) is 404 and never reaches the superagent.
    for (const [path, input] of [
      ['inbox/accept', { id: 'corp-suggestion' }], ['inbox/dismiss', { id: 'corp-dismiss' }],
      ['inbox/approval/decide', { id: 'corp-approval', decision: 'approve', reason: 'mine now' }],
      ['inbox/accept', { id: 'hermes-binding' }], ['inbox/dismiss', { id: 'hermes-binding' }],
      ['inbox/accept', { id: 'no-such-item' }],
    ] as const) assert.equal((await call(bob, path, input)).status, 404, `Finance member reaches ${input.id} through ${path}`);
    // A viewer of the right workspace is refused by role (403).
    for (const [path, input] of [
      ['inbox/accept', { id: 'corp-suggestion' }], ['inbox/dismiss', { id: 'corp-dismiss' }],
      ['inbox/approval/decide', { id: 'corp-approval', decision: 'approve', reason: 'viewer' }],
    ] as const) assert.equal((await call(carol, path, input)).status, 403, `viewer acts through ${path}`);
    assert.deepEqual(await fixture('test/actions'), [], 'no refused action reached the superagent');

    // Members act on their own workspace's items.
    assert.equal((await call(alice, 'inbox/accept', { id: 'corp-suggestion' })).status, 200);
    assert.equal((await call(alice, 'inbox/dismiss', { id: 'corp-dismiss' })).status, 200);
    assert.equal((await call(alice, 'inbox/approval/decide', { id: 'corp-approval', decision: 'approve', reason: 'ok' })).status, 200);
    assert.equal((await call(bob, 'inbox/accept', { id: 'finance-suggestion' })).status, 200);
    assert.deepEqual(await fixture('test/actions'), ['accept:corp-suggestion', 'dismiss:corp-dismiss', 'decide:corp-approval',
      'accept:finance-suggestion']);

    // New items are stamped with the caller's workspace by the Gateway, whatever the caller sends.
    const asked = await call(bob, 'inbox/ask', { text: 'Close the books', botId: 'bot', workspace: corp.id });
    assert.equal(asked.status, 200);
    assert.equal(asked.body.workspace, finance.id);
    assert.ok((await ids(bob)).includes(asked.body.id));
    assert.ok(!(await ids(alice)).includes(asked.body.id));
    console.log('P6-10_INBOX PASS list/accept/dismiss/decide stay in the caller workspace; workspace-less bindings are hidden');

    // The accept mode is per workspace too (owner's active workspace is Corp).
    assert.equal((await call(owner, 'inbox/acceptMode/set', { mode: 'act' })).status, 200);
    assert.equal((await call(alice, 'inbox/acceptMode/get', {})).body.mode, 'act');
    assert.equal((await call(bob, 'inbox/acceptMode/get', {})).body.mode, 'observe', 'Corp\'s accept mode does not reach Finance');
    console.log('P6-10_ACCEPT_MODE PASS accept mode is keyed by the caller workspace');
  } finally {
    await gateway.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
