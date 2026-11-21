import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { startGateway } from '../src/server.js';

const root = await mkdtemp(join(tmpdir(), 'neo-p310-resource-'));
const extensionsDir = join(root, 'extensions');
const sources: Record<string, string> = {
  'engine-hermes': `export default {activate(ctx) {ctx.health(() => ({ok: true}));}};`,
  'engine-dsh': `export default {activate(ctx) {
    const owners = new Map();
    ctx.route('test/seed', ({body}) => {owners.set(body.sessionId, body.workspaceId); return {ok: true};});
    ctx.route('session/workspace', ({body}) => ({workspaceId: owners.get(body.sessionId)}));
    ctx.health(() => ({ok: true}));
  }};`,
  'engine-superagent': `export default {activate(ctx) {
    const items = [];
    ctx.route('test/seed', ({body}) => {items.push(body); return {ok: true};});
    ctx.route('list', () => items);
    ctx.health(() => ({ok: true}));
  }};`,
};
for (const [id, source] of Object.entries(sources)) {
  const dir = join(extensionsDir, id);
  await mkdir(dir, {recursive: true});
  await writeFile(join(dir, 'neo.extension.json'), JSON.stringify({id, version: '0.1.0', displayName: id,
    runtime: {type: 'cordis', entry: './index.ts'}}));
  await writeFile(join(dir, 'index.ts'), source);
}
const gateway = await startGateway({databaseFile: join(root, 'gateway.sqlite'), dataDir: root,
  mode: 'server', signup: 'open', extensionsDir});
try {
  const base = `http://127.0.0.1:${gateway.port}`;
  const auth = async (path: string, body: object, token?: string): Promise<any> => {
    const response = await fetch(`${base}/auth/${path}`, {method: 'POST',
      headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})},
      body: JSON.stringify(body)});
    assert.equal(response.status, 200, `${path} HTTP ${response.status}`);
    return response.json();
  };
  await auth('sign-up/email', {email: 'resources@neo.test', password: 'TestPassword!123', name: 'Owner'});
  const token = (await auth('sign-in/email', {email: 'resources@neo.test', password: 'TestPassword!123'})).token;
  const alpha = await auth('organization/create', {name: 'Alpha', slug: `a-${randomUUID()}`}, token);
  const bravo = await auth('organization/create', {name: 'Bravo', slug: `b-${randomUUID()}`}, token);
  const client = async (workspaceId: string): Promise<any> => {
    const key = await auth('api-key/create', {name: `key-${workspaceId.slice(0, 8)}`, expiresIn: 3600,
      metadata: {workspaceId, role: 'admin'}}, token);
    return createORPCClient<any>(new RPCLink({url: base, headers: {'x-api-key': key.key}}));
  };
  const rpcA = await client(alpha.id);
  const rpcB = await client(bravo.id);
  for (const id of Object.keys(sources)) {
    assert.equal((await rpcA.extensions.enable({id})).status, 'running', `${id} running`);
  }
  const botA = await rpcA.agents.bots.create({name: 'Alpha bot'});
  const botB = await rpcB.agents.bots.create({name: 'Bravo bot'});
  const turnId = randomUUID();
  const approvalId = randomUUID();
  const now = Date.now();
  await gateway.db.agents.createTurn({id: turnId, bot_id: botA.id, room_id: null,
    source: 'user', input: 'hello', status: 'awaiting_approval', created_at: now, updated_at: now});
  await gateway.db.agents.createApproval({id: approvalId, turn_id: turnId, request_id: randomUUID(),
    tool: 'safe_tool', detail: 'private', status: 'pending', created_at: now, resolved_at: null});
  const denied = (error: any) => error.code === 'NOT_FOUND';
  await assert.rejects(rpcB.agents.bots.update({id: botA.id, name: 'hijacked'}), denied);
  await assert.rejects(rpcB.agents.bots.delete({id: botA.id}), denied);
  await assert.rejects(rpcB.agents.turns.send({botId: botA.id, text: 'hijack'}), denied);
  await assert.rejects(rpcB.agents.turns.list({botId: botA.id}), denied);
  await assert.rejects(rpcB.agents.turns.stop({turnId}), denied);
  await assert.rejects(rpcB.agents.approvals.list({turnId}), denied);
  await assert.rejects(rpcB.agents.approvals.resolve({id: approvalId, decision: 'deny'}), denied);
  await assert.rejects((async () => {for await (const _ of await rpcB.agents.turns.events({turnId})) break;})(), denied);
  assert.equal((await gateway.db.agents.getBot(botA.id))?.name, 'Alpha bot');
  assert.equal((await gateway.db.agents.getApproval(approvalId))?.status, 'pending');
  assert.equal((await rpcA.agents.turns.list({botId: botA.id})).length, 1);
  assert.equal((await rpcA.agents.approvals.list({turnId})).length, 1);
  assert.equal((await rpcA.agents.bots.update({id: botA.id, name: 'Updated by Alpha'})).name, 'Updated by Alpha');
  assert.equal((await rpcB.agents.bots.list()).length, 1);
  assert.equal((await rpcA.agents.approvals.resolve({id: approvalId, decision: 'deny'})).resolved, false); // seeded approval has no live waiter

  const driver = () => ({screen: () => ({protocol: 'png' as const}), lease: () => {}, input: () => {},
    capture: () => ({png: 'fake', width: 1, height: 1})});
  const unregister = gateway.computers.registerProvider('resource-fake', {
    capabilities: {screen: true, input: true, browserCdp: false, shell: false, files: false, snapshot: false},
    provision: () => driver(), attach: () => driver(), release: () => {},
  });
  try {
    const computerA = await rpcA.computers.provision({providerId: 'resource-fake', spec: {}});
    const computerB = await rpcB.computers.provision({providerId: 'resource-fake', spec: {}});
    const sessionId = 'dsh-session-b';
    await gateway.kernel.invokeRoute('/x/engine-dsh/test/seed', 'RPC', {sessionId, workspaceId: bravo.id});
    await rpcB.computers.assign({engine: 'dsh', targetId: sessionId, computerId: computerB.id});
    await assert.rejects(rpcA.computers.assign({engine: 'dsh', targetId: sessionId, computerId: computerA.id}), denied);
    const profileId = 'superagent-profile-b';
    await gateway.kernel.invokeRoute('/x/engine-superagent/test/seed', 'RPC', {id: randomUUID(), botId: profileId, workspace: bravo.id});
    await rpcB.computers.assign({engine: 'superagent', targetId: profileId, computerId: computerB.id});
    await assert.rejects(rpcA.computers.assign({engine: 'superagent', targetId: profileId, computerId: computerA.id}), denied);
    assert.ok(gateway.computers.binding('dsh', sessionId, bravo.id));
    assert.ok(gateway.computers.binding('superagent', profileId, bravo.id));
    assert.equal(gateway.computers.binding('dsh', sessionId, alpha.id), undefined);
    assert.equal(gateway.computers.binding('superagent', profileId, alpha.id), undefined);
  } finally {await unregister();}
  console.log('P3-10 RESOURCE PASS bot-turn-approval-isolation=true dsh-superagent-assignment-isolation=true');
} finally {
  await gateway.close();
  await rm(root, {recursive: true, force: true});
}


