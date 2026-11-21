import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  createNeoAuth,
  migrateAuthSchema,
  bootstrapDesktopAuth,
  deploymentOwnerLookup,
  resolveAuthContext,
  requireViewer,
  requireMember,
  requireAdminOrOwner,
  requireOwner,
  transferDeploymentOwner,
  NeoRole,
  NeoAuthContext,
} from '../src/index.js';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-0123456789';

test('deployment owner migration backfills the first account and preserves an atomic transfer', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    const auth = createNeoAuth({ sqlite, secret: TEST_SECRET, mode: 'server' });
    await migrateAuthSchema(auth);
    const signup = (name: string) => auth.api.signUpEmail({
      body: { email: `${name}@deployment.test`, password: 'DeploymentFixture!123', name },
    });
    const first = await signup('first');
    const second = await signup('second');
    const third = await signup('third');
    assert.ok(deploymentOwnerLookup(sqlite)(first.user.id));
    sqlite.exec('DROP TRIGGER neo_assign_first_deployment_owner; DROP TABLE neo_deployment_owner');
    await migrateAuthSchema(auth);
    const owns = deploymentOwnerLookup(sqlite);
    assert.ok(owns(first.user.id), 'existing deployments promote their earliest account');
    const results = await Promise.all([
      transferDeploymentOwner(auth.kysely, first.user.id, second.user.id),
      transferDeploymentOwner(auth.kysely, first.user.id, third.user.id),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    await migrateAuthSchema(auth);
    assert.equal(owns(first.user.id), false);
    assert.equal(owns(second.user.id), results[0]);
    assert.equal(owns(third.user.id), results[1]);
  } finally { sqlite.close(); }
});

test('createNeoAuth throws when options.secret is missing', () => {
  assert.throws(() => createNeoAuth({}), (err: any) => err.message.includes('options.secret is required'));
});

test('Better Auth migrations and bootstrapDesktopAuth idempotence and session pruning', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const auth = createNeoAuth({ sqlite, secret: TEST_SECRET });
  await migrateAuthSchema(auth);

  // First bootstrap run
  const res1 = await bootstrapDesktopAuth(auth, {
    email: 'local.owner@neo.local',
    workspaceName: 'Local Dev Workspace',
    workspaceSlug: 'local-dev',
  });

  assert.equal(res1.bootstrapped, true);
  assert.equal(res1.user.email, 'local.owner@neo.local');
  assert.equal(res1.workspace.name, 'Local Dev Workspace');
  assert.ok(res1.token);

  // Check that session count is 1
  let sessions = await auth.kysely.selectFrom('session').selectAll().execute();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].userAgent, 'Neo-Desktop/1.0');

  // Second bootstrap run on the exact same database
  const res2 = await bootstrapDesktopAuth(auth, {
    email: 'local.owner@neo.local',
  });

  assert.equal(res2.bootstrapped, false);
  assert.equal(res2.user.id, res1.user.id);
  assert.equal(res2.workspace.id, res1.workspace.id);
  assert.ok(res2.token);

  // Prior session must be pruned, leaving exactly 1 session
  sessions = await auth.kysely.selectFrom('session').selectAll().execute();
  assert.equal(sessions.length, 1, 'Previous desktop session must be pruned on restart');
  assert.equal(sessions[0].token, res2.token);
});

test('Organization roles and membership (owner, admin, member, viewer)', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const auth = createNeoAuth({ sqlite, secret: TEST_SECRET });
  await migrateAuthSchema(auth);

  // 1. Owner
  const owner = await auth.api.signUpEmail({
    body: { email: 'owner@test.local', password: 'OwnerPass!123', name: 'Owner' },
  });
  const org = await auth.api.createOrganization({
    body: { name: 'Acme Corp', slug: 'acme' },
    headers: new Headers({ authorization: `Bearer ${owner.token}` }),
  });
  await auth.api.setActiveOrganization({
    body: { organizationId: org.id },
    headers: new Headers({ authorization: `Bearer ${owner.token}` }),
  });

  // Verify owner context
  const ownerCtx = await resolveAuthContext(auth, new Headers({ authorization: `Bearer ${owner.token}` }));
  assert.equal(ownerCtx.user?.email, 'owner@test.local');
  assert.equal(ownerCtx.workspaceId, org.id);
  assert.equal(ownerCtx.role, 'owner');
  assert.doesNotThrow(() => requireViewer(ownerCtx));
  assert.doesNotThrow(() => requireMember(ownerCtx));
  assert.doesNotThrow(() => requireAdminOrOwner(ownerCtx));
  assert.doesNotThrow(() => requireOwner(ownerCtx));

  // 2. Member
  const memberUser = await auth.api.signUpEmail({
    body: { email: 'member@test.local', password: 'MemberPass!123', name: 'Member' },
  });
  await auth.api.addMember({
    body: { organizationId: org.id, userId: memberUser.user.id, role: 'member' },
    headers: new Headers({ authorization: `Bearer ${owner.token}` }),
  });
  await auth.api.setActiveOrganization({
    body: { organizationId: org.id },
    headers: new Headers({ authorization: `Bearer ${memberUser.token}` }),
  });
  const memberCtx = await resolveAuthContext(auth, new Headers({ authorization: `Bearer ${memberUser.token}` }));
  assert.equal(memberCtx.user?.email, 'member@test.local');
  assert.equal(memberCtx.role, 'member');
  assert.doesNotThrow(() => requireViewer(memberCtx));
  assert.doesNotThrow(() => requireMember(memberCtx));
  assert.throws(() => requireAdminOrOwner(memberCtx), (err: any) => err.status === 403);
  assert.throws(() => requireOwner(memberCtx), (err: any) => err.status === 403);

  // 3. Viewer
  const viewerUser = await auth.api.signUpEmail({
    body: { email: 'viewer@test.local', password: 'ViewerPass!123', name: 'Viewer' },
  });
  await auth.api.addMember({
    body: { organizationId: org.id, userId: viewerUser.user.id, role: 'viewer' },
    headers: new Headers({ authorization: `Bearer ${owner.token}` }),
  });
  await auth.api.setActiveOrganization({
    body: { organizationId: org.id },
    headers: new Headers({ authorization: `Bearer ${viewerUser.token}` }),
  });
  const viewerCtx = await resolveAuthContext(auth, new Headers({ authorization: `Bearer ${viewerUser.token}` }));
  assert.equal(viewerCtx.user?.email, 'viewer@test.local');
  assert.equal(viewerCtx.role, 'viewer');
  assert.doesNotThrow(() => requireViewer(viewerCtx));
  assert.throws(() => requireMember(viewerCtx), (err: any) => err.status === 403);
  assert.throws(() => requireAdminOrOwner(viewerCtx), (err: any) => err.status === 403);
  assert.throws(() => requireOwner(viewerCtx), (err: any) => err.status === 403);

  // 4. User with no workspace membership
  const outsider = await auth.api.signUpEmail({
    body: { email: 'outsider@test.local', password: 'OutsiderPass!123', name: 'Outsider' },
  });
  const outsiderCtx = await resolveAuthContext(auth, new Headers({ authorization: `Bearer ${outsider.token}` }));
  assert.equal(outsiderCtx.user?.email, 'outsider@test.local');
  assert.equal(outsiderCtx.role, null, 'User with no membership must have role null');
  assert.throws(() => requireViewer(outsiderCtx), (err: any) => err.status === 403);
  assert.throws(() => requireMember(outsiderCtx), (err: any) => err.status === 403);
});

test('API Key lifecycle: issue -> scoped use -> expire -> revoke -> deny missing role', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const auth = createNeoAuth({ sqlite, secret: TEST_SECRET });
  await migrateAuthSchema(auth);

  const boot = await bootstrapDesktopAuth(auth);

  // 1. Issue an API key with role: member
  const apiKeyRes = await auth.api.createApiKey({
    body: {
      name: 'ci-automation-key',
      metadata: {
        role: 'member',
        workspaceId: boot.workspace.id,
      },
      expiresIn: 2, // 2 seconds
    },
    headers: new Headers({ authorization: `Bearer ${boot.token}` }),
  });

  assert.ok(apiKeyRes?.key, 'API key must be generated');
  const keySecret = apiKeyRes.key;

  // 2. Scoped use via x-api-key header
  const authCtxApiKey = await resolveAuthContext(auth, new Headers({ 'x-api-key': keySecret }));
  assert.equal(authCtxApiKey.role, 'member');
  assert.equal(authCtxApiKey.workspaceId, boot.workspace.id);
  assert.equal(authCtxApiKey.apiKey?.name, 'ci-automation-key');

  // Also verify Bearer <apiKey> format
  const authCtxBearer = await resolveAuthContext(auth, new Headers({ authorization: `Bearer ${keySecret}` }));
  assert.equal(authCtxBearer.role, 'member');
  assert.equal(authCtxBearer.workspaceId, boot.workspace.id);

  // 3. API key without metadata.role must be denied (null user and role)
  const noRoleKey = await auth.api.createApiKey({
    body: {
      name: 'no-role-key',
      metadata: { workspaceId: boot.workspace.id },
      expiresIn: 3600,
    },
    headers: new Headers({ authorization: `Bearer ${boot.token}` }),
  });
  const noRoleCtx = await resolveAuthContext(auth, new Headers({ 'x-api-key': noRoleKey.key }));
  assert.equal(noRoleCtx.user, null, 'API key without role in metadata must be denied');
  assert.equal(noRoleCtx.role, null);

  // 4. Issue a revocable API key
  const revocableRes = await auth.api.createApiKey({
    body: {
      name: 'revocable-key',
      metadata: { role: 'viewer', workspaceId: boot.workspace.id },
      expiresIn: 3600,
    },
    headers: new Headers({ authorization: `Bearer ${boot.token}` }),
  });

  // Verify before revocation
  const preRevoke = await resolveAuthContext(auth, new Headers({ 'x-api-key': revocableRes.key }));
  assert.equal(preRevoke.role, 'viewer');

  // Revoke key
  await auth.api.deleteApiKey({
    body: { keyId: revocableRes.id },
    headers: new Headers({ authorization: `Bearer ${boot.token}` }),
  });

  // Verify after revocation
  const postRevoke = await resolveAuthContext(auth, new Headers({ 'x-api-key': revocableRes.key }));
  assert.equal(postRevoke.user, null, 'Revoked key must not resolve user');
  assert.equal(postRevoke.role, null, 'Revoked key must not resolve role');

  // 5. Test expiration
  await new Promise((r) => setTimeout(r, 2200));
  const postExpire = await resolveAuthContext(auth, new Headers({ 'x-api-key': keySecret }));
  assert.equal(postExpire.user, null, 'Expired key must not resolve user');
});

test('No ambient authority: tokenless requests always resolve to null user', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const auth = createNeoAuth({ sqlite, secret: TEST_SECRET });
  await migrateAuthSchema(auth);

  const boot = await bootstrapDesktopAuth(auth);

  // 1. Unauthenticated request on loopback in desktop mode -> rejected (null)
  const loopbackCtx = await resolveAuthContext(auth, new Headers(), {
    mode: 'desktop',
  });
  assert.equal(loopbackCtx.user, null, 'Unauthenticated loopback request must have null user');
  assert.equal(loopbackCtx.role, null);

  // 2. Unauthenticated request in server mode -> rejected (null)
  const serverCtx = await resolveAuthContext(auth, new Headers(), {
    mode: 'server',
  });
  assert.equal(serverCtx.user, null, 'Unauthenticated server request must have null user');

  // 3. Invalid Bearer token -> rejected (null)
  const invalidTokenCtx = await resolveAuthContext(
    auth,
    new Headers({ authorization: 'Bearer invalid_bogus_token' }),
    { mode: 'desktop' }
  );
  assert.equal(invalidTokenCtx.user, null, 'Invalid token must be rejected');

  // 4. Authenticated bearer token with bootstrap token -> resolves owner
  const validCtx = await resolveAuthContext(
    auth,
    new Headers({ authorization: 'Bearer ' + boot.token }),
    { mode: 'desktop' }
  );
  assert.equal(validCtx.user?.id, boot.user.id);
  assert.equal(validCtx.role, 'owner');
});
