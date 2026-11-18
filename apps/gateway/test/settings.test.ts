import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGateway } from '../src/server.js';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';

type GatewayClient = ContractRouterClient<typeof neoContract>;

function makeClient(port: number, headers: Record<string, string> = {}): GatewayClient {
  return createORPCClient<GatewayClient>(
    new RPCLink({
      url: `http://127.0.0.1:${port}`,
      headers: () => headers,
    })
  );
}

test('Step 2: settings.get (viewer, secrets sanitized) and settings.set (admin, secrets to vault, event emitted)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nmh-settings-test-'));
  const databaseFile = join(root, 'gateway.db');
  const extensionsDir = join(root, 'extensions');
  await mkdir(extensionsDir, { recursive: true });

  // Create a sample extension with settings schema
  const extDir = join(extensionsDir, 'test-settings-ext');
  await mkdir(join(extDir, 'src'), { recursive: true });

  const manifest = {
    id: 'test-settings-ext',
    version: '1.0.0',
    displayName: 'Test Settings Extension',
    runtime: { type: 'cordis', entry: 'src/index.mjs' },
    settings: {
      type: 'object',
      properties: {
        greeting: { type: 'string', default: 'Hello' },
        retries: { type: 'number', default: 5 },
        apiKey: { type: 'string', secret: true },
      },
    },
  };

  await writeFile(join(extDir, 'neo.extension.json'), JSON.stringify(manifest, null, 2));

  // Extension script uses ctx.inject('settings')
  const extCode = `
export default {
  activate(ctx) {
    const settings = ctx.inject('settings');
    ctx.route('hello', async () => ({
      greeting: settings?.greeting,
      retries: settings?.retries,
      hasSecret: Boolean(settings?.apiKey),
      rawSecret: settings?.apiKey,
    }));
  }
};
`;
  await writeFile(join(extDir, 'src', 'index.mjs'), extCode);

  const gateway = await startGateway({
    databaseFile,
    extensionsDir,
    mode: 'server',
  });

  const base = `http://127.0.0.1:${gateway.port}`;

  try {
    // 1. Setup accounts: admin/owner and viewer
    const ownerRes = await fetch(`${base}/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@neo.local', password: 'AdminPassword!123', name: 'Admin' }),
    });
    const ownerUser = await ownerRes.json();
    const ownerLogin = await (await fetch(`${base}/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@neo.local', password: 'AdminPassword!123' }),
    })).json();
    const adminToken = ownerLogin.token;

    const orgRes = await fetch(`${base}/auth/organization/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: 'Test Org', slug: 'test-org' }),
    });
    const workspace = await orgRes.json();

    const viewerRes = await fetch(`${base}/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'viewer@neo.local', password: 'ViewerPassword!123', name: 'Viewer' }),
    });
    const viewerUser = await viewerRes.json();
    const viewerLogin = await (await fetch(`${base}/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'viewer@neo.local', password: 'ViewerPassword!123' }),
    })).json();
    const viewerToken = viewerLogin.token;

    await gateway.auth.api.addMember({
      body: { organizationId: workspace.id, userId: viewerUser.user.id, role: 'viewer' },
      headers: new Headers({ authorization: `Bearer ${adminToken}` }),
    });

    const adminClient = makeClient(gateway.port, { authorization: `Bearer ${adminToken}` });
    const viewerClient = makeClient(gateway.port, { authorization: `Bearer ${viewerToken}` });

    // Enable the extension
    await adminClient.extensions.enable({ id: 'test-settings-ext' });

    // 2. Viewer calls settings.get({ extension })
    const initialSettings = await viewerClient.settings.get({ extension: 'test-settings-ext' });
    assert.equal(initialSettings.values.greeting, 'Hello');
    assert.equal(initialSettings.values.retries, 5);
    assert.deepEqual(initialSettings.values.apiKey, { set: false });

    // 3. Extension route initially sees default settings
    const routeInitRes = await fetch(`${base}/x/test-settings-ext/hello`, {
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    const routeInit = await routeInitRes.json();
    assert.equal(routeInit.greeting, 'Hello');
    assert.equal(routeInit.retries, 5);
    assert.equal(routeInit.hasSecret, false);

    // 4. Viewer tries to call settings.set -> 403 Forbidden
    await assert.rejects(
      viewerClient.settings.set({
        extension: 'test-settings-ext',
        values: { greeting: 'Hacked' },
      }),
      (err: any) => err.code === 'FORBIDDEN',
      'Viewer must not be allowed to call settings.set'
    );

    // 5. Admin calls settings.set({ extension, values })
    const updateResult = await adminClient.settings.set({
      extension: 'test-settings-ext',
      values: {
        greeting: 'Bonjour',
        retries: 10,
        apiKey: 'super-secret-vault-token-xyz',
      },
    });

    // Sanitized output in set response: secret is write-only!
    assert.equal(updateResult.values.greeting, 'Bonjour');
    assert.equal(updateResult.values.retries, 10);
    assert.deepEqual(updateResult.values.apiKey, { set: true });

    // 6. Viewer calls settings.get: sees new values and secret: { set: true }, NOT plaintext!
    const updatedViewerGet = await viewerClient.settings.get({ extension: 'test-settings-ext' });
    assert.equal(updatedViewerGet.values.greeting, 'Bonjour');
    assert.equal(updatedViewerGet.values.retries, 10);
    assert.deepEqual(updatedViewerGet.values.apiKey, { set: true });
    assert.equal((updatedViewerGet.values as any).apiKey.secret, undefined);

    // 7. Running extension sees the new values and sees decrypted secret in vault!
    const routeUpdatedRes = await fetch(`${base}/x/test-settings-ext/hello`, {
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    const routeUpdated = await routeUpdatedRes.json();
    assert.equal(routeUpdated.greeting, 'Bonjour');
    assert.equal(routeUpdated.retries, 10);
    assert.equal(routeUpdated.hasSecret, true);
    assert.equal(routeUpdated.rawSecret, 'super-secret-vault-token-xyz');
  } finally {
    await gateway.close();
  }
});
