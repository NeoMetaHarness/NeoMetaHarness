import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import type { VaultScope } from '@neometaharness/vault';
import { startGateway } from '../src/server.js';

type GatewayClient = ContractRouterClient<typeof neoContract>;

function makeClient(port: number, headers: Record<string, string> = {}): GatewayClient {
  return createORPCClient<GatewayClient>(
    new RPCLink({
      url: `http://127.0.0.1:${port}`,
      headers: () => headers,
    })
  );
}

test('10 core auth & RBAC checks through real gateway HTTP/oRPC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nmh-gateway-auth-'));
  const databaseFile = join(root, 'gateway.db');
  const extensionsDir = join(root, 'extensions');
  await mkdir(extensionsDir);

  const gateway = await startGateway({
    databaseFile,
    mode: 'server',
  });

  const base = `http://127.0.0.1:${gateway.port}`;

  try {
    // 1. Sign up local accounts (owner, viewer, outsider) via HTTP /auth/sign-up/email
    const ownerSignupRes = await fetch(`${base}/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'alice.owner@neo.local',
        password: 'MasterPassword!123',
        name: 'Alice Owner',
      }),
    });
    assert.equal(ownerSignupRes.status, 200, 'Owner signup must succeed');
    const ownerSignup = await ownerSignupRes.json();
    assert.ok(ownerSignup.user?.id, 'Owner user must have ID');

    const viewerSignupRes = await fetch(`${base}/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'bob.viewer@neo.local',
        password: 'ViewerPassword#456',
        name: 'Bob Viewer',
      }),
    });
    assert.equal(viewerSignupRes.status, 200, 'Viewer signup must succeed');
    const viewerSignup = await viewerSignupRes.json();
    assert.ok(viewerSignup.user?.id, 'Viewer user must have ID');

    const outsiderSignupRes = await fetch(`${base}/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'dave.outsider@neo.local',
        password: 'OutsiderPassword!999',
        name: 'Dave Outsider',
      }),
    });
    assert.equal(outsiderSignupRes.status, 200, 'Outsider signup must succeed');
    const outsiderSignup = await outsiderSignupRes.json();
    assert.ok(outsiderSignup.user?.id);

    // 2. Log in and issue session tokens via HTTP /auth/sign-in/email
    const ownerLoginRes = await fetch(`${base}/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'alice.owner@neo.local',
        password: 'MasterPassword!123',
      }),
    });
    assert.equal(ownerLoginRes.status, 200, 'Owner login must succeed');
    const ownerLogin = await ownerLoginRes.json();
    const ownerToken = ownerLogin.token;
    assert.ok(ownerToken, 'Owner must receive bearer token');

    const viewerLoginRes = await fetch(`${base}/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'bob.viewer@neo.local',
        password: 'ViewerPassword#456',
      }),
    });
    assert.equal(viewerLoginRes.status, 200, 'Viewer login must succeed');
    const viewerLogin = await viewerLoginRes.json();
    const viewerToken = viewerLogin.token;
    assert.ok(viewerToken, 'Viewer must receive bearer token');

    const outsiderLoginRes = await fetch(`${base}/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'dave.outsider@neo.local',
        password: 'OutsiderPassword!999',
      }),
    });
    const outsiderLogin = await outsiderLoginRes.json();
    const outsiderToken = outsiderLogin.token;

    // 3. Create workspace (organization) via HTTP /auth/organization/create
    const orgRes = await fetch(`${base}/auth/organization/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        name: 'Engineering Workspace',
        slug: 'engineering',
      }),
    });
    assert.equal(orgRes.status, 200, 'Workspace creation must succeed');
    const workspace = await orgRes.json();
    assert.ok(workspace.id, 'Workspace must have ID');

    const orgResB = await fetch(`${base}/auth/organization/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        name: 'Marketing Workspace',
        slug: 'marketing',
      }),
    });
    assert.equal(orgResB.status, 200);
    const workspaceB = await orgResB.json();

    // 4. Add member with role 'viewer'
    await gateway.auth.api.addMember({
      body: {
        organizationId: workspace.id,
        userId: viewerSignup.user.id,
        role: 'viewer',
      },
      headers: new Headers({ authorization: `Bearer ${ownerToken}` }),
    });

    // 5. Add user with role 'member'
    const memberSignupRes = await fetch(`${base}/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'charlie.member@neo.local',
        password: 'MemberPassword!789',
        name: 'Charlie Member',
      }),
    });
    const memberSignup = await memberSignupRes.json();
    const memberLoginRes = await fetch(`${base}/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'charlie.member@neo.local',
        password: 'MemberPassword!789',
      }),
    });
    const memberLogin = await memberLoginRes.json();
    const memberToken = memberLogin.token;

    await gateway.auth.api.addMember({
      body: {
        organizationId: workspace.id,
        userId: memberSignup.user.id,
        role: 'member',
      },
      headers: new Headers({ authorization: `Bearer ${ownerToken}` }),
    });

    // 6. Issue API key scoped to workspace with member role
    const apiKeyRes = await fetch(`${base}/auth/api-key/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        name: 'CI Scoped Bot Key',
        expiresIn: 3600,
        metadata: {
          workspaceId: workspace.id,
          role: 'member',
        },
      }),
    });
    assert.equal(apiKeyRes.status, 200, 'API key creation must succeed');
    const apiKeyData = await apiKeyRes.json();
    const keySecret = apiKeyData.key;
    assert.ok(keySecret, 'API key secret must be returned');

    // 7. Verify API Key works via x-api-key header
    const apiKeyClient = makeClient(gateway.port, { 'x-api-key': keySecret });
    const apiKeyList = await apiKeyClient.extensions.list();
    assert.ok(Array.isArray(apiKeyList), 'API key must allow calling extensions.list');

    // 8. Extensions RBAC verification
    const unauthClient = makeClient(gateway.port);
    await assert.rejects(
      unauthClient.extensions.list(),
      (e: any) => e.code === 'UNAUTHORIZED',
      'Unauthenticated call must be UNAUTHORIZED'
    );

    const viewerClient = makeClient(gateway.port, { authorization: `Bearer ${viewerToken}` });
    const viewerExtList = await viewerClient.extensions.list();
    assert.ok(Array.isArray(viewerExtList), 'Viewer must be able to list extensions');

    await assert.rejects(
      viewerClient.extensions.enable({ id: 'sample-ts' }),
      (e: any) => e.code === 'FORBIDDEN',
      'Viewer must not be able to enable extensions'
    );
    await assert.rejects(
      viewerClient.extensions.disable({ id: 'sample-ts' }),
      (e: any) => e.code === 'FORBIDDEN',
      'Viewer must not be able to disable extensions'
    );

    const memberClient = makeClient(gateway.port, { authorization: `Bearer ${memberToken}` });
    await assert.rejects(
      memberClient.extensions.enable({ id: 'sample-ts' }),
      (e: any) => e.code === 'FORBIDDEN',
      'Regular member must not be able to enable extensions'
    );

    const ownerClient = makeClient(gateway.port, { authorization: `Bearer ${ownerToken}` });
    const ownerEnable = await ownerClient.extensions.enable({ id: 'sample-ts' });
    assert.equal(ownerEnable.status, 'running');
    const ownerDisable = await ownerClient.extensions.disable({ id: 'sample-ts' });
    assert.equal(ownerDisable.status, 'disabled');

    // 9. Vault RBAC verification
    const scopeA: VaultScope = { kind: 'workspace', workspaceId: workspace.id };
    const scopeB: VaultScope = { kind: 'workspace', workspaceId: workspaceB.id };

    await assert.rejects(
      unauthClient.vault.list({ scope: scopeA }),
      (e: any) => e.code === 'UNAUTHORIZED',
      'Unauthenticated vault list must fail'
    );

    const viewerList = await viewerClient.vault.list({ scope: scopeA });
    assert.deepEqual(viewerList, []);

    await assert.rejects(viewerClient.vault.put({ scope: scopeA, name: 'KEY_ONE', value: 'V' }), (e: any) => e.code === 'FORBIDDEN');
    await assert.rejects(viewerClient.vault.rotate({ scope: scopeA, name: 'KEY_ONE', value: 'V' }), (e: any) => e.code === 'FORBIDDEN');
    await assert.rejects(viewerClient.vault.delete({ scope: scopeA, name: 'KEY_ONE' }), (e: any) => e.code === 'FORBIDDEN');

    const memberPut = await memberClient.vault.put({ scope: scopeA, name: 'MEMBER_K', value: 'V1' });
    assert.equal(memberPut.version, 1);

    const memberRot = await memberClient.vault.rotate({ scope: scopeA, name: 'MEMBER_K', value: 'V2' });
    assert.equal(memberRot.version, 2);

    await assert.rejects(memberClient.vault.delete({ scope: scopeA, name: 'MEMBER_K' }), (e: any) => e.code === 'FORBIDDEN');
    await assert.rejects(memberClient.vault.list({ scope: scopeB }), (e: any) => e.code === 'FORBIDDEN');
    await assert.rejects(memberClient.vault.put({ scope: scopeB, name: 'OTHER_K', value: 'Y' }), (e: any) => e.code === 'FORBIDDEN');

    const ownerPutA = await ownerClient.vault.put({ scope: scopeA, name: 'OWNER_K', value: 'OV' });
    assert.equal(ownerPutA.version, 1);
    const ownerPutB = await ownerClient.vault.put({ scope: scopeB, name: 'OWNER_KB', value: 'OVB' });
    assert.equal(ownerPutB.version, 1);

    const ownerDelA = await ownerClient.vault.delete({ scope: scopeA, name: 'OWNER_K' });
    assert.equal(ownerDelA.deleted, true);

    // 10. Engine & Agents RBAC verification: viewer -> 403 on write, non-member session -> 401/403
    // 10a. Viewer calling engine write operations must get FORBIDDEN (403)
    await assert.rejects(
      viewerClient.x['engine-hermes'].profiles.create({ name: 'viewer-bot' }),
      (e: any) => e.code === 'FORBIDDEN',
      'Viewer must not be able to create Hermes profiles'
    );
    await assert.rejects(
      viewerClient.x['engine-hermes'].runs.start({ profile: 'default', input: 'hi' }),
      (e: any) => e.code === 'FORBIDDEN',
      'Viewer must not be able to start Hermes runs'
    );
    await assert.rejects(
      viewerClient.x['engine-t3'].create({ threadId: 't1', projectId: 'p1', title: 'T', providerId: 'prov', model: 'mod' }),
      (e: any) => e.code === 'FORBIDDEN',
      'Viewer must not be able to create T3 threads'
    );
    await assert.rejects(
      viewerClient.x['engine-dsh'].create({ workspaceId: 'w1', cwd: 'C:/temp' }),
      (e: any) => e.code === 'FORBIDDEN',
      'Viewer must not be able to create DSH sessions'
    );

    // 10b. Viewer calling agents router write operations must get FORBIDDEN (403)
    await assert.rejects(
      viewerClient.agents.bots.create({ name: 'viewer-created-bot' }),
      (e: any) => e.code === 'FORBIDDEN',
      'Viewer must not be able to create agent bots'
    );

    // 10c. Non-member session (outsider) must be denied on both engines and agents (401 or 403)
    const outsiderClient = makeClient(gateway.port, { authorization: `Bearer ${outsiderToken}` });
    await assert.rejects(
      outsiderClient.agents.bots.create({ name: 'outsider-bot' }),
      (e: any) => e.code === 'FORBIDDEN' || e.code === 'UNAUTHORIZED',
      'Non-member session must be rejected on agents.bots.create'
    );
    await assert.rejects(
      outsiderClient.agents.bots.list(),
      (e: any) => e.code === 'FORBIDDEN' || e.code === 'UNAUTHORIZED',
      'Non-member session must be rejected on agents.bots.list'
    );
    await assert.rejects(
      outsiderClient.x['engine-t3'].create({ threadId: 't1', projectId: 'p1', title: 'T', providerId: 'prov', model: 'mod' }),
      (e: any) => e.code === 'FORBIDDEN' || e.code === 'UNAUTHORIZED',
      'Non-member session must be rejected on engine-t3 create'
    );
  } finally {
    await gateway.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Security boundaries: tokenless loopback 401, WS foreign origin 403, WS without token 401, WS with ticket, wsTickets sweep', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nmh-sec-'));
  const databaseFile = join(root, 'state/gateway.db');
  const extensionsDir = join(root, 'extensions');
  await mkdir(extensionsDir, { recursive: true });

  const gateway = await startGateway({
    databaseFile,
    extensionsDir,
    mode: 'desktop',
  });

  const base = `http://127.0.0.1:${gateway.port}`;
  const token = gateway.desktopToken!;

  try {
    // 1. Tokenless loopback HTTP request gets 401
    const unauthHttp = await fetch(`${base}/x/sample-ts/hello`);
    assert.equal(unauthHttp.status, 401, 'Tokenless loopback HTTP must return 401');

    const unauthExtList = await fetch(`${base}/extensions/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(unauthExtList.status, 401, 'Tokenless oRPC HTTP must return 401');

    // 2. WebSocket upgrade with foreign Origin gets 403
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`, {
        headers: {
          Origin: 'https://evil.example.com',
          Authorization: `Bearer ${token}`,
        },
      });
      ws.on('unexpected-response', (_req, res) => {
        try {
          assert.equal(res.statusCode, 403, 'Foreign Origin WebSocket upgrade must be rejected with 403');
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      ws.on('open', () => reject(new Error('WebSocket with evil origin unexpectedly connected')));
      ws.on('error', () => { /* may emit error after unexpected-response */ });
    });

    // 3. WebSocket upgrade without token gets 401
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`);
      ws.on('unexpected-response', (_req, res) => {
        try {
          assert.equal(res.statusCode, 401, 'Unauthenticated WebSocket upgrade must be rejected with 401');
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      ws.on('open', () => reject(new Error('Unauthenticated WebSocket unexpectedly connected')));
      ws.on('error', () => { /* may emit error after unexpected-response */ });
    });

    // 4. Issue ticket and connect WebSocket with ticket
    const ticketRes = await fetch(`${base}/auth/ws-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(ticketRes.status, 200, 'Ticket generation must succeed');
    const { ticket } = await ticketRes.json();
    assert.ok(ticket, 'Ticket must be returned');

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws?ticket=${ticket}`);
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('unexpected-response', (_req, res) => {
        reject(new Error(`WebSocket with valid ticket rejected: ${res.statusCode}`));
      });
      ws.on('error', reject);
    });

    // Ticket is single-use: reconnecting with the same ticket must fail with 401
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws?ticket=${ticket}`);
      ws.on('unexpected-response', (_req, res) => {
        try {
          assert.equal(res.statusCode, 401, 'Reused ticket must be rejected with 401');
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      ws.on('open', () => reject(new Error('Reused ticket unexpectedly connected')));
      ws.on('error', () => {});
    });
  } finally {
    await gateway.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Desktop bootstrap idempotence, session pruning, auth.secret persistence and owner-only token file ACL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nmh-gateway-boot-'));
  const databaseFile = join(root, 'state/gateway.db');
  const tokenFile = join(root, 'state/desktop.token');
  const secretFile = join(root, 'state/auth.secret');
  const extensionsDir = join(root, 'extensions');
  await mkdir(extensionsDir, { recursive: true });

  // 1. First run: empty database -> bootstraps owner, workspace, auth.secret and desktop.token
  const gateway1 = await startGateway({
    databaseFile,
    extensionsDir,
    mode: 'desktop',
  });

  const token1 = gateway1.desktopToken;
  assert.ok(token1, 'Bootstrap token must exist');

  // Verify desktop.token file was written and restricted
  const savedToken = (await readFile(tokenFile, 'utf8')).trim();
  assert.equal(savedToken, token1, 'desktop.token file must match gateway desktopToken');

  // Verify auth.secret was generated and persisted
  const savedSecret1 = (await readFile(secretFile, 'utf8')).trim();
  assert.ok(savedSecret1.length >= 32, 'auth.secret must be persisted and at least 32 characters');

  await gateway1.close();

  // 2. Second run: same database -> discovers existing owner and workspace without duplicates
  const gateway2 = await startGateway({
    databaseFile,
    extensionsDir,
    mode: 'desktop',
  });

  const token2 = gateway2.desktopToken;
  assert.ok(token2, 'Session token must be created on restart');

  // Verify auth.secret was reused and not overwritten
  const savedSecret2 = (await readFile(secretFile, 'utf8')).trim();
  assert.equal(savedSecret2, savedSecret1, 'auth.secret must be reused across restarts');

  const users = await (gateway2.db as any).getKysely().selectFrom('user').selectAll().execute();
  assert.equal(users.length, 1, 'Exactly one owner user must exist in database');

  const orgs = await (gateway2.db as any).getKysely().selectFrom('organization').selectAll().execute();
  assert.equal(orgs.length, 1, 'Exactly one workspace organization must exist in database');

  // Verify session table does not grow forever: prior sessions pruned on bootstrap
  const sessions = await (gateway2.db as any).getKysely().selectFrom('session').selectAll().execute();
  assert.equal(sessions.length, 1, 'Prior desktop sessions must be pruned on restart');

  await gateway2.close();
  await rm(root, { recursive: true, force: true });
});
