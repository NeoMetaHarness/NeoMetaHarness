// P1-13 review: Model Hub providers, keys, roles and Panda router settings are per workspace in server mode.
// The bootstrap workspace inherits the configuration stored before P1-13; the deployment's own ('default')
// configuration still serves deployment-level work (Hermes profiles). Fake endpoints only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGateway } from '../src/server.js';

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('P1-13 server: model provider keys, roles and router settings are each workspace\'s own', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nmh-p113-models-'));
  const databaseFile = join(root, 'state/gateway.db');
  const gateway = await startGateway({ databaseFile, dataDir: join(root, 'data'), mode: 'server', signup: 'open' });
  const base = `http://127.0.0.1:${gateway.port}`;
  try {
    // Configuration from before P1-13: one deployment-wide provider with its key in the 'default' scope.
    const deploymentDir = join(root, 'state', 'extensions', 'models', 'models');
    await mkdir(deploymentDir, { recursive: true });
    await writeFile(join(deploymentDir, 'settings.json'), JSON.stringify({ revision: 1, overrides: {},
      providers: [{ id: 'legacy', kind: 'openai-compatible', name: 'Legacy', baseUrl: 'http://127.0.0.1:9/v1', hasKey: true }],
      roles: { default: { providerId: 'legacy', model: 'legacy-model' } } }));
    await gateway.vault.put({ kind: 'workspace', workspaceId: 'default' }, 'NEO_MODEL_LEGACY_KEY', 'legacy-key');

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
    const financeAdmin = await signUp('admin@finance.test');
    const invite = await (await fetch(`${base}/auth/organization/invite-member`,
      json({ organizationId: finance.id, email: 'admin@finance.test', role: 'admin' }, as(corpOwner)))).json() as { id: string };
    assert.equal((await fetch(`${base}/auth/organization/accept-invitation`, json({ invitationId: invite.id }, as(financeAdmin)))).status, 200);
    const rpc = async (token: string, path: string, input?: unknown) => {
      const response = await fetch(`${base}/${path}`, json(input === undefined ? {} : { json: input }, as(token)));
      return { status: response.status, body: response.ok ? (await response.json() as { json: any }).json : undefined };
    };
    for (const id of ['models', 'models-router-panda']) {
      assert.equal((await rpc(corpOwner, 'extensions/enable', { id })).status, 200, id);
    }

    // Corp is the bootstrap workspace: it starts from the pre-P1-13 configuration. Finance starts empty.
    assert.deepEqual((await rpc(corpOwner, 'x/models/providers/list')).body.map((p: any) => p.id), ['legacy']);
    assert.deepEqual((await rpc(financeAdmin, 'x/models/providers/list')).body, []);

    // Each workspace configures the same provider id with its own key and model.
    for (const [token, key, model] of [[corpOwner, 'corp-key', 'corp-model'], [financeAdmin, 'finance-key', 'finance-model']]) {
      assert.equal((await rpc(token, 'x/models/providers/put', { id: 'shared', kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:9/v1', apiKey: key })).status, 200);
      assert.equal((await rpc(token, 'x/models/roles/set', { role: 'coding', providerId: 'shared', model })).status, 200);
    }
    assert.deepEqual((await rpc(corpOwner, 'x/models/providers/list')).body.map((p: any) => p.id).sort(), ['legacy', 'shared']);
    assert.deepEqual((await rpc(financeAdmin, 'x/models/providers/list')).body.map((p: any) => p.id), ['shared']);
    assert.equal((await rpc(corpOwner, 'x/models/roles/get')).body.coding.model, 'corp-model');
    assert.equal((await rpc(financeAdmin, 'x/models/roles/get')).body.coding.model, 'finance-model');
    assert.equal(await gateway.vault.get({ kind: 'workspace', workspaceId: corp.id }, 'NEO_MODEL_SHARED_KEY'), 'corp-key');
    assert.equal(await gateway.vault.get({ kind: 'workspace', workspaceId: finance.id }, 'NEO_MODEL_SHARED_KEY'), 'finance-key');
    assert.equal(await gateway.vault.get({ kind: 'workspace', workspaceId: 'default' }, 'NEO_MODEL_SHARED_KEY'), undefined);

    // Engines resolve for the workspace of the work they serve.
    const hub = (gateway.kernel as any).snapshot.services.get('modelHub');
    assert.deepEqual(await hub.resolve('coding', undefined, undefined, corp.id).then((b: any) => [b.model, b.apiKey]), ['corp-model', 'corp-key']);
    assert.deepEqual(await hub.resolve('coding', undefined, { text: 't', workspace: finance.id }).then((b: any) => [b.model, b.apiKey]),
      ['finance-model', 'finance-key']);
    // Deployment-level work (Hermes profiles) keeps the deployment's configuration.
    assert.deepEqual(await hub.resolve('default').then((b: any) => [b.model, b.apiKey]), ['legacy-model', 'legacy-key']);
    await assert.rejects(hub.resolve('coding'), /unconfigured/, 'no workspace\'s binding leaks into deployment-level work');

    // Deleting Finance's provider leaves Corp's alone.
    assert.equal((await rpc(financeAdmin, 'x/models/providers/delete', { id: 'shared' })).status, 200);
    assert.equal(await gateway.vault.get({ kind: 'workspace', workspaceId: corp.id }, 'NEO_MODEL_SHARED_KEY'), 'corp-key');
    assert.equal((await rpc(corpOwner, 'x/models/roles/get')).body.coding.model, 'corp-model');
    console.log('P1-13_MODELS_WORKSPACE PASS provider keys, roles and deletions stay in their workspace; deployment work keeps its own');

    // Panda router settings are per workspace too.
    const panda = { endpoint: 'http://127.0.0.1:9', timeoutMs: 100, roles: { coding: [{ modelId: 'corp-m', providerId: 'shared', model: 'corp-model' }] } };
    assert.equal((await rpc(corpOwner, 'x/models-router-panda/settings/set', panda)).status, 200);
    assert.equal((await rpc(corpOwner, 'x/models-router-panda/settings/get')).body.endpoint, 'http://127.0.0.1:9');
    assert.equal((await rpc(financeAdmin, 'x/models-router-panda/settings/get')).body, null, 'Finance does not see Corp\'s router');
    console.log('P1-13_PANDA_WORKSPACE PASS router settings stay in their workspace');
  } finally {
    await gateway.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
