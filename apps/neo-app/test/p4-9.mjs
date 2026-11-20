import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { fakeHoncho } from './fake-honcho.mjs';

// P4-9 exit: memory dreaming + report, standing intents. A scripted fake Honcho on a random port, a
// fake Hermes model and the scripted superagent adapter; no real Honcho, no network, no credentials.
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '../..');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const HONCHO_KEY = 'isolated-honcho-key';

async function eventually(check, name, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error('Timed out observing ' + name);
}

function upstreamCache() {
  if (process.env.NMH_UPSTREAM_CACHE) return process.env.NMH_UPSTREAM_CACHE;
  for (let parent = repo; ; parent = dirname(parent)) {
    const candidate = join(parent, 'nmh-upstream-cache');
    if (existsSync(candidate)) return candidate;
    if (dirname(parent) === parent) throw new Error('Set NMH_UPSTREAM_CACHE to the pinned source cache');
  }
}

async function fakeModel() {
  const calls = [];
  const server = createHttpServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.method === 'GET' && req.url === '/v1/models') return send(200, { object: 'list', data: [{ id: 'fake-model', object: 'model' }] });
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) return send(404, {});
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push(input);
    if (!input.stream) {
      return send(200, { id: 'p4-9', object: 'chat.completion', model: 'fake-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }] });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const push = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'p4-9',
      object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    push({ role: 'assistant', content: '' }); push({ content: 'Noted.' }); push({}, 'stop');
    res.end('data: [DONE]\n\n');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { calls, url: 'http://127.0.0.1:' + server.address().port + '/v1',
    async close() { server.closeAllConnections(); await new Promise((done) => server.close(done)); } };
}

async function startGateway(dbFile, hermesHome, modelUrl, extraEnv = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: join(repo, 'apps', 'gateway'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    env: { ...process.env, NODE_ENV: 'test',
      NMH_SUPERAGENT_TEST_ADAPTER: new URL('../../../extensions/engine-superagent/test/scripted-models.ts', import.meta.url).href,
      NMH_UPSTREAM_CACHE: upstreamCache(), NMH_DB_PATH: dbFile, NMH_HERMES_HOME: hermesHome, NMH_HERMES_MODEL_URL: modelUrl,
      NMH_EXTENSIONS_DIR: join(repo, 'extensions'), NMH_PORT: '0', NEO_MODE: 'desktop', NEO_PRINT_DESKTOP_TOKEN: '1',
      ...extraEnv },
  });
  let token = '';
  let stderr = '';
  child.stderr.on('data', (bytes) => { stderr += bytes.toString(); });
  const port = await new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('Gateway startup timeout ' + stderr)), 30000);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (line.startsWith('NEO_DESKTOP_TOKEN ')) token = line.slice(18).trim();
      if (line.startsWith('GATEWAY_READY ')) { clearTimeout(timeout); lines.close(); done(JSON.parse(line.slice(14)).port); }
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error('Gateway exited ' + code + ': ' + stderr)));
  });
  assert.ok(token, 'Desktop authorization token missing');
  const base = 'http://127.0.0.1:' + port;
  return { base, token, errors: () => stderr,
    rpc: createORPCClient(new RPCLink({ url: base, headers: () => ({ authorization: 'Bearer ' + token }) })),
    async close() {
      if (child.exitCode !== null) return;
      const exited = new Promise((done) => child.once('exit', done));
      child.send('shutdown');
      await Promise.race([exited, sleep(10000).then(() => { throw new Error('Gateway shutdown timed out'); })]);
      assert.equal(child.exitCode, 0, 'Gateway shutdown failed: ' + stderr);
    } };
}

/** Desktop sign-up is closed (P7-2): an owner API key restricted to a role exercises the same policy. */
async function clientAs(gateway, role) {
  const headers = { authorization: 'Bearer ' + gateway.token };
  const { session } = await (await fetch(gateway.base + '/auth/get-session', { headers })).json();
  const response = await fetch(gateway.base + '/auth/api-key/create', { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ name: `P4-9 ${role}`, expiresIn: 3600, metadata: { workspaceId: session.activeOrganizationId, role } }) });
  assert.equal(response.status, 200, `${role} key creation failed`);
  const { key } = await response.json();
  return createORPCClient(new RPCLink({ url: gateway.base, headers: { 'x-api-key': key } }));
}

async function runHermes(gateway, input) {
  const started = await gateway.rpc.x['engine-hermes'].runs.start({ profile: 'bota', input });
  const socket = new WebSocket(gateway.base.replace(/^http/, 'ws') + '/ws', ['bearer.' + gateway.token]);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  try {
    const { RPCLink: WsLink } = await import('@orpc/client/websocket');
    const events = createORPCClient(new WsLink({ websocket: socket }));
    for await (const event of await events.x['engine-hermes'].runs.events({ profile: 'bota', runId: started.run_id })) {
      if (['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(event.type)) {
        assert.equal(event.type, 'run.completed', 'Hermes turn must complete');
        return;
      }
    }
  } finally { socket.close(); }
}

/** Seed a non-turn fact straight into the fake Honcho, the way HonchoStore would write it. */
async function seedHoncho(honcho, text) {
  const hash = (value) => 'nmh_' + createHash('sha256').update(value).digest('hex').slice(0, 24);
  const root = honcho.url + '/v3/workspaces/' + hash('default');
  const post = async (url, body) => {
    const response = await fetch(url, { method: 'POST', body: JSON.stringify(body),
      headers: { authorization: 'Bearer ' + HONCHO_KEY, 'content-type': 'application/json' } });
    assert.equal(response.status, 200, 'fake Honcho seed failed');
  };
  await post(honcho.url + '/v3/workspaces', { id: hash('default') });
  await post(root + '/sessions', { id: hash('global'), peers: { nmh_user: {}, nmh_bot: {} } });
  await post(root + '/sessions/' + hash('global') + '/messages', { messages: [{ content: text, peer_id: 'nmh_user',
    metadata: { subject: 'user', subjectId: 'global', source: 'manual', provenance: 'seeded in Honcho', trust: 'observed' } }] });
}

async function trial() {
  const temp = await mkdtemp(join(tmpdir(), 'nmh-p4-9-'));
  const honcho = await fakeHoncho(HONCHO_KEY);
  const model = await fakeModel();
  const dbFile = join(temp, 'state.sqlite');
  let gateway;
  let stage = 'gateway startup';
  try {
    gateway = await startGateway(dbFile, join(temp, 'hermes-home'), model.url);
    const { rpc } = gateway;
    const scope = { kind: 'workspace', workspaceId: 'default' };
    await rpc.vault.put({ scope, name: 'HONCHO_URL', value: honcho.url });
    await rpc.vault.put({ scope, name: 'HONCHO_API_KEY', value: HONCHO_KEY });
    for (const id of ['memory-local', 'memory-honcho', 'engine-hermes', 'engine-superagent']) {
      const state = await rpc.extensions.enable({ id });
      assert.equal(state.status, 'running', id + ': ' + state.reason + gateway.errors());
    }
    await rpc.x['engine-hermes'].profiles.create({ name: 'bota' });
    const member = await clientAs(gateway, 'member');
    const viewer = await clientAs(gateway, 'viewer');
    const local = async (text) => (await rpc.x['memory-local'].list({ workspace: 'default', query: '' }))
      .filter((entry) => entry.text === text);
    const memoryItems = async () => (await rpc.inbox.list()).filter((item) => item.source === 'neo/memory');
    const item = async (id) => (await rpc.inbox.list()).find((entry) => entry.id === id);
    const seen = (text, after) => model.calls.slice(after).some((call) => JSON.stringify(call).includes(text));

    stage = 'standing intents';
    await assert.rejects(viewer.x['memory-local'].intents.add({ text: 'Viewer intent' }), 'viewers cannot add intents');
    const intent = await member.x['memory-local'].intents.add({ text: 'Always answer in British English.' });
    assert.equal(intent.source, 'neo.intent');
    assert.equal(intent.trust, 'confirmed');
    assert.match(intent.provenance, /^user:\S+ via Neo app$/, 'provenance is the authenticated user');
    assert.deepEqual((await viewer.x['memory-local'].intents.list({})).map((entry) => entry.id), [intent.id]);
    const plain = await member.x['memory-local'].add({ subject: 'user', text: 'Not an intent', trust: 'confirmed' });
    assert.deepEqual(await member.x['memory-local'].intents.retract({ id: plain.id }), { retracted: false });
    assert.equal((await local('Not an intent')).length, 1, 'only intents can be retracted as intents');
    let before = model.calls.length;
    await runHermes(gateway, 'What should I keep in mind?');
    assert.ok(seen('Standing intents:', before) && seen('Always answer in British English.', before),
      'the next Hermes model request carries the standing intent through the memory projection');
    const ephemeral = await member.x['memory-local'].intents.add({ text: 'Remind me about the dentist.' });
    assert.deepEqual(await member.x['memory-local'].intents.retract({ id: ephemeral.id }), { retracted: true });
    before = model.calls.length;
    await runHermes(gateway, 'Anything else?');
    assert.ok(!seen('dentist', before), 'a retracted intent leaves the projection');
    console.log('P4-9_STAGE standing intents: member-only, user provenance, projected into Hermes, retractable');

    stage = 'observe dream';
    await rpc.inbox.acceptMode.set({ mode: 'observe' });
    for (let copy = 0; copy < 2; copy++) await member.x['memory-local'].add({ subject: 'user', text: 'User prefers green tea', trust: 'observed' });
    await member.x['memory-local'].add({ subject: 'user', text: 'Deploy window is Friday', trust: 'confirmed' });
    await seedHoncho(honcho, 'Project codename is Papaya');
    await assert.rejects(viewer.x['memory-honcho'].dream.run({}), 'viewers cannot run a dream');
    const observed = await member.x['memory-honcho'].dream.run({});
    assert.equal(observed.status, 'proposed');
    assert.equal(observed.acceptMode, 'observe');
    const kinds = new Set(observed.proposals.map((proposal) => proposal.kind));
    for (const kind of ['dedupe', 'promote', 'sync-l2', 'sync-l1']) assert.ok(kinds.has(kind), 'missing ' + kind);
    assert.ok(observed.proposals.every((proposal) => !/^(Noted\.|What should|Anything else)/.test(proposal.text)), 'turns are never consolidated');
    const suggestion = await item(observed.inboxId);
    assert.equal(suggestion.status, 'suggestion');
    assert.equal(suggestion.destructive, true);
    assert.equal(suggestion.dream.id, observed.id);
    assert.match(suggestion.report.summary, /proposes/);
    const dreamsDir = join(temp, 'extensions', 'memory-honcho', 'dreams');
    const reports = (await readdir(dreamsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    assert.equal(reports.length, 1);
    assert.match(await readFile(join(dreamsDir, reports[0].name, 'DREAMS.md'), 'utf8'), /\*\*dedupe\*\* \(destructive\)/);
    assert.equal((await local('User prefers green tea')).length, 2, 'observe writes nothing');
    assert.ok(!honcho.writes.some((write) => write.content === 'Deploy window is Friday'), 'observe writes nothing to L2');
    assert.equal((await viewer.x['memory-honcho'].dream.last({})).status, 'proposed');
    assert.equal((await member.x['memory-honcho'].dream.run({})).id, observed.id, 'a pending dream is not proposed twice');
    assert.equal((await memoryItems()).length, 1);
    await assert.rejects(member.inbox.accept({ id: suggestion.id }), 'deleting memory needs an admin');
    const accepted = await rpc.inbox.accept({ id: suggestion.id });
    assert.equal(accepted.status, 'ready', JSON.stringify(accepted.report));
    const tea = await local('User prefers green tea');
    assert.equal(tea.length, 1);
    assert.equal(tea[0].trust, 'confirmed');
    assert.match(tea[0].provenance, /promoted by dream/);
    const papaya = await local('Project codename is Papaya');
    assert.equal(papaya[0]?.trust, 'observed');
    assert.match(papaya[0].provenance, /^honcho:/);
    assert.ok(honcho.writes.some((write) => write.content === 'Deploy window is Friday' && /l1=/.test(write.metadata.provenance)));
    assert.equal((await rpc.x['memory-honcho'].dream.last({})).status, 'applied');
    const settled = await member.x['memory-honcho'].dream.run({});
    assert.equal(settled.status, 'empty', 'a consolidated memory has nothing left: ' + JSON.stringify(settled.proposals));
    console.log('P4-9_STAGE observe: report + DREAMS.md, nothing written until an admin accepts, then L1 <-> L2 consolidated');

    stage = 'act-with-approval dream';
    await rpc.inbox.acceptMode.set({ mode: 'act-with-approval' });
    await member.x['memory-local'].add({ subject: 'user', text: 'Prefers dark mode', trust: 'observed' });
    await seedHoncho(honcho, 'Prefers dark mode');
    const approve = await member.x['memory-honcho'].dream.run({});
    assert.equal(approve.status, 'proposed');
    const approval = await item(approve.inboxId);
    assert.equal(approval.status, 'approval');
    assert.equal(approval.approval.destructive, false);
    assert.equal((await local('Prefers dark mode'))[0].trust, 'observed');
    assert.equal((await member.inbox.approval.decide({ id: approval.id, decision: 'approve', reason: 'Looks right' })).status, 'ready');
    assert.equal((await local('Prefers dark mode'))[0].trust, 'confirmed');
    await member.x['memory-local'].add({ subject: 'user', text: 'Likes ramen', trust: 'observed' });
    await seedHoncho(honcho, 'Likes ramen');
    const deny = await member.x['memory-honcho'].dream.run({});
    const denied = await member.inbox.approval.decide({ id: deny.inboxId, decision: 'deny', reason: 'Not sure yet' });
    assert.equal(denied.status, 'blocked');
    assert.equal((await rpc.x['memory-honcho'].dream.last({})).status, 'rejected');
    assert.equal((await local('Likes ramen'))[0].trust, 'observed', 'a denied dream writes nothing');
    console.log('P4-9_STAGE act-with-approval: member approves non-destructive dreams; a denial writes nothing');

    stage = 'act dream';
    await rpc.inbox.acceptMode.set({ mode: 'act' });
    const acted = await member.x['memory-honcho'].dream.run({});
    assert.equal(acted.status, 'applied', 'act writes a non-destructive dream directly');
    assert.equal((await item(acted.inboxId)).status, 'ready');
    assert.equal((await local('Likes ramen'))[0].trust, 'confirmed');
    await member.x['memory-local'].add({ subject: 'user', text: 'Likes ramen', trust: 'observed' });
    const destructive = await member.x['memory-honcho'].dream.run({});
    assert.equal(destructive.status, 'proposed', 'act still asks before deleting memory');
    const gate = await item(destructive.inboxId);
    assert.equal(gate.status, 'approval');
    assert.equal(gate.approval.destructive, true);
    await assert.rejects(member.inbox.approval.decide({ id: gate.id, decision: 'approve', reason: 'ok' }), 'deletion needs admin');
    console.log('P4-9_STAGE act: non-destructive dreams apply at once; deletions wait for an admin');

    stage = 'toggle isolation';
    assert.equal((await rpc.extensions.disable({ id: 'memory-honcho' })).status, 'disabled');
    // The Gateway masks extension errors; the item staying pending below is the observable proof.
    await assert.rejects(rpc.inbox.approval.decide({ id: gate.id, decision: 'approve', reason: 'ok' }));
    assert.equal((await item(gate.id)).status, 'approval', 'the dream stays pending while memory-honcho is off');
    const statuses = Object.fromEntries((await rpc.extensions.list()).map((entry) => [entry.id, entry.status]));
    for (const id of ['memory-local', 'engine-hermes', 'engine-superagent']) assert.equal(statuses[id], 'running', id);
    assert.equal(await rpc.x['memory-honcho'].status({}), 'off');
    before = model.calls.length;
    await runHermes(gateway, 'Still there?');
    assert.ok(seen('Always answer in British English.', before), 'standing intents survive disabling memory-honcho');
    assert.equal((await rpc.extensions.enable({ id: 'memory-honcho' })).status, 'running');
    assert.equal((await rpc.inbox.approval.decide({ id: gate.id, decision: 'approve', reason: 'Dedupe ramen' })).status, 'ready');
    assert.equal((await local('Likes ramen')).length, 1, 'the persisted dream applies after re-enabling');
    assert.equal((await rpc.extensions.disable({ id: 'engine-superagent' })).status, 'disabled');
    await member.x['memory-local'].add({ subject: 'user', text: 'Likes ramen', trust: 'observed' });
    const undelivered = await member.x['memory-honcho'].dream.run({});
    assert.equal(undelivered.status, 'undelivered');
    assert.equal((await local('Likes ramen')).length, 2, 'without the Inbox nothing is applied');
    assert.equal((await rpc.extensions.enable({ id: 'engine-superagent' })).status, 'running');
    console.log('P4-9_STAGE toggle: memory-honcho off keeps L1, intents and Inbox healthy; no Inbox means no writes');

    stage = 'nightly schedule after restart';
    await rpc.inbox.acceptMode.set({ mode: 'observe' });
    const known = new Set((await memoryItems()).map((entry) => entry.id));
    await gateway.close();
    gateway = await startGateway(dbFile, join(temp, 'hermes-home'), model.url, { NMH_HONCHO_DREAM_INTERVAL_MS: '800' });
    for (const id of ['memory-local', 'memory-honcho', 'engine-hermes', 'engine-superagent']) {
      const state = (await gateway.rpc.extensions.list()).find((entry) => entry.id === id);
      if (state?.status !== 'running') assert.equal((await gateway.rpc.extensions.enable({ id })).status, 'running', id);
    }
    const scheduled = await eventually(async () => (await gateway.rpc.inbox.list())
      .find((entry) => entry.source === 'neo/memory' && !known.has(entry.id)), 'scheduled dream Suggestion');
    assert.equal(scheduled.status, 'suggestion');
    assert.equal(scheduled.destructive, true);
    await sleep(2000);
    assert.equal((await gateway.rpc.inbox.list()).filter((entry) => entry.source === 'neo/memory' && !known.has(entry.id)).length, 1,
      'repeated scheduled passes do not duplicate a pending dream');
    assert.equal((await gateway.rpc.inbox.accept({ id: scheduled.id })).status, 'ready');
    console.log('P4-9_STAGE nightly timer dreams on its own after a restart, once per pending change set');
  } catch (error) {
    console.error('P4-9_FAILURE at', stage, error, 'GATEWAY STDERR', gateway?.errors());
    throw error;
  } finally {
    if (gateway) await gateway.close();
    await model.close();
    await honcho.close();
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

await trial();
console.log('P4-9_EXIT PASS dreaming report and proposals, accept modes, standing intents, toggle isolation');
