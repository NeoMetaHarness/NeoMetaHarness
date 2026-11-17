import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  createNeoAuth,
  migrateAuthSchema,
  bootstrapDesktopAuth,
  resolveAuthContext,
  NeoRole,
  NeoAuthContext,
} from '../src/index.js';

test('Better Auth migrations and bootstrapDesktopAuth idempotence', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const auth = createNeoAuth({ sqlite });
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

  // Second bootstrap run on the exact same database
  const res2 = await bootstrapDesktopAuth(auth, {
    email: 'local.owner@neo.local',
  });

  assert.equal(res2.bootstrapped, false);
  assert.equal(res2.user.id, res1.user.id);
  assert.equal(res2.workspace.id, res1.workspace.id);
  assert.ok(res2.token);
});

test('Organization roles and membership (owner, admin, member, viewer)', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const auth = createNeoAuth({ sqlite });
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
});

test('API Key lifecycle: issue -> scoped use -> expire -> revoke', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const auth = createNeoAuth({ sqlite });
  await migrateAuthSchema(auth);

  const boot = await bootstrapDesktopAuth(auth);

  // 1. Issue an API key
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

  // 3. Issue a revocable API key
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

  // 4. Test expiration
  await new Promise((r) => setTimeout(r, 2200));
  const postExpire = await resolveAuthContext(auth, new Headers({ 'x-api-key': keySecret }));
  assert.equal(postExpire.user, null, 'Expired key must not resolve user');
});

test('Desktop mode loopback fallback and security boundaries', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const auth = createNeoAuth({ sqlite });
  await migrateAuthSchema(auth);

  const boot = await bootstrapDesktopAuth(auth);
  const bootstrapContext: NeoAuthContext = {
    user: boot.user,
    session: boot.session,
    workspaceId: boot.workspace.id,
    role: 'owner',
  };

  // 1. Unauthenticated request from loopback in desktop mode -> inherits bootstrap context
  const loopbackCtx = await resolveAuthContext(auth, new Headers(), {
    mode: 'desktop',
    isLoopback: true,
    bootstrapContext,
  });
  assert.equal(loopbackCtx.user?.id, boot.user.id);
  assert.equal(loopbackCtx.role, 'owner');

  // 2. Unauthenticated request from non-loopback in desktop mode -> rejected (null)
  const nonLoopbackCtx = await resolveAuthContext(auth, new Headers(), {
    mode: 'desktop',
    isLoopback: false,
    bootstrapContext,
  });
  assert.equal(nonLoopbackCtx.user, null);

  // 3. Invalid Bearer token even on loopback -> rejected (null)
  const invalidTokenCtx = await resolveAuthContext(
    auth,
    new Headers({ authorization: 'Bearer invalid_bogus_token' }),
    {
      mode: 'desktop',
      isLoopback: true,
      bootstrapContext,
    }
  );
  assert.equal(invalidTokenCtx.user, null, 'Explicit bad token must not fall back to bootstrap context');
});
