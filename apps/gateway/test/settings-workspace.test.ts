// P1-13: extension settings and secrets are per workspace. Server mode keeps two workspaces apart (values,
// secrets, what an extension sees while serving each), saveSettings refuses wrong types, and a desktop upgrade
// moves the pre-P1-13 settings into the desktop workspace without loss.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { coerceSettingValues, SettingsValidationError } from '@neometaharness/kernel';
import { startGateway } from '../src/server.js';

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const EXT = 'p113-settings';
const SECRET_NAME = 'SEC_APIKEY';

async function fixture(root: string) {
  const extensions = join(root, 'extensions');
  await mkdir(join(extensions, EXT, 'src'), { recursive: true });
  await writeFile(join(extensions, 'package.json'), '{"type":"module"}');
  await writeFile(join(extensions, EXT, 'neo.extension.json'), JSON.stringify({ id: EXT, version: '0.1.0',
    displayName: 'P1-13 settings fixture', runtime: { type: 'cordis', entry: './src/index.mjs' },
    settings: { type: 'object', properties: {
      greeting: { type: 'string', default: 'Hello' },
      enabled: { type: 'boolean', default: true },
      retries: { type: 'integer', default: 3, minimum: 0, maximum: 10 },
      apiKey: { type: 'string', secret: true },
    } } }));
  // The extension API is unchanged: it reads ctx.inject('settings') synchronously, and may use settingsFor(ws)
  // for background work.
  await writeFile(join(extensions, EXT, 'src', 'index.mjs'), `
export default { activate(ctx) {
  const settings = ctx.inject('settings');
  const settingsFor = ctx.inject('settingsFor');
  ctx.health(() => ({ ok: true }));
  ctx.route('hello', () => ({ greeting: settings.greeting, enabled: settings.enabled, retries: settings.retries,
    apiKey: settings.apiKey ?? null, keys: Object.keys(settings).sort() }));
  ctx.route('background', async ({ body }) => { const values = await settingsFor(body.workspace); return { greeting: values.greeting, apiKey: values.apiKey ?? null }; });
} };`);
  return extensions;
}

test('P1-13 server: two workspaces keep their own settings and secrets; wrong types are refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nmh-p113-server-'));
  const gateway = await startGateway({ databaseFile: join(root, 'state/gateway.db'), dataDir: join(root, 'data'),
    extensionsDir: await fixture(root), mode: 'server', signup: 'open' });
  const base = `http://127.0.0.1:${gateway.port}`;
  try {
    const signUp = async (email: string) => {
      const response = await fetch(`${base}/auth/sign-up/email`, json({ email, password: 'Member!Pass123', name: 'x' }));
      assert.equal(response.status, 200, email);
      return (await response.json() as { token: string }).token;
    };
    const as = (token: string) => ({ authorization: `Bearer ${token}` });
    // Only the instance owner may create workspaces; Finance gets its own admin.
    const corpOwner = await signUp('owner@corp.test');
    const corp = await (await fetch(`${base}/auth/organization/create`, json({ name: 'Corp', slug: 'corp' }, as(corpOwner)))).json() as { id: string };
    const finance = await (await fetch(`${base}/auth/organization/create`,
      json({ name: 'Finance', slug: 'finance', keepCurrentActiveOrganization: true }, as(corpOwner)))).json() as { id: string };
    const financeOwner = await signUp('admin@finance.test');
    const invite = await (await fetch(`${base}/auth/organization/invite-member`,
      json({ organizationId: finance.id, email: 'admin@finance.test', role: 'admin' }, as(corpOwner)))).json() as { id: string };
    assert.equal((await fetch(`${base}/auth/organization/accept-invitation`, json({ invitationId: invite.id }, as(financeOwner)))).status, 200);
    assert.equal((await fetch(`${base}/extensions/enable`, json({ json: { id: EXT } }, as(corpOwner)))).status, 200);
    const rpc = async (token: string, path: string, input: unknown) => {
      const response = await fetch(`${base}/${path}`, json({ json: input }, as(token)));
      return { status: response.status, body: response.ok ? (await response.json() as { json: any }).json : undefined };
    };
    const hello = async (token: string) => (await fetch(`${base}/x/${EXT}/hello`, { headers: as(token) })).json() as Promise<any>;

    assert.equal((await rpc(corpOwner, 'settings/set', { extension: EXT, values: { greeting: 'Hello Corp', retries: 5, apiKey: 'corp-key' } })).status, 200);
    assert.equal((await rpc(financeOwner, 'settings/set', { extension: EXT, values: { greeting: 'Hello Finance', enabled: false, apiKey: 'finance-key' } })).status, 200);

    const corpSettings = (await rpc(corpOwner, 'settings/get', { extension: EXT })).body.values;
    const financeSettings = (await rpc(financeOwner, 'settings/get', { extension: EXT })).body.values;
    assert.deepEqual(corpSettings, { greeting: 'Hello Corp', enabled: true, retries: 5, apiKey: { set: true } });
    assert.deepEqual(financeSettings, { greeting: 'Hello Finance', enabled: false, retries: 3, apiKey: { set: true } });

    // The running extension sees the settings of the workspace whose request it serves.
    assert.deepEqual(await hello(corpOwner), { greeting: 'Hello Corp', enabled: true, retries: 5, apiKey: 'corp-key',
      keys: ['apiKey', 'enabled', 'greeting', 'retries'] });
    assert.deepEqual(await hello(financeOwner), { greeting: 'Hello Finance', enabled: false, retries: 3, apiKey: 'finance-key',
      keys: ['apiKey', 'enabled', 'greeting', 'retries'] });
    // Secrets are stored per workspace in the vault.
    assert.equal(await gateway.vault.get({ kind: 'engine', workspaceId: corp.id, subjectId: EXT }, SECRET_NAME), 'corp-key');
    assert.equal(await gateway.vault.get({ kind: 'engine', workspaceId: finance.id, subjectId: EXT }, SECRET_NAME), 'finance-key');
    assert.equal(await gateway.vault.get({ kind: 'engine', workspaceId: 'default', subjectId: EXT }, SECRET_NAME), undefined);
    // Background work names its workspace; work outside any workspace sees defaults and no secret (fails closed).
    assert.deepEqual(await gateway.kernel.invokeRoute(`/x/${EXT}/background`, 'RPC', { workspace: finance.id }),
      { greeting: 'Hello Finance', apiKey: 'finance-key' });
    const outside = await gateway.kernel.invokeRoute(`/x/${EXT}/hello`, 'GET') as any;
    assert.deepEqual([outside.greeting, outside.apiKey], ['Hello', null]);
    // settings.change events carry their workspace; a server-mode subscriber hears only its own.
    const heard = async (token: string) => {
      const client = createORPCClient<ContractRouterClient<typeof neoContract>>(new RPCLink({
        url: base, headers: () => as(token) }));
      const controller = new AbortController();
      const events: any[] = [];
      setTimeout(() => controller.abort(), 1500);
      try {
        for await (const event of await client.events.subscribe({ since: 0 }, { signal: controller.signal })) {
          if (event.type === 'settings.change') events.push(event);
        }
      } catch (error) { if (!controller.signal.aborted) throw error; }
      return events.map((event) => [event.workspaceId, event.values.greeting]);
    };
    assert.deepEqual(await heard(corpOwner), [[corp.id, 'Hello Corp']]);
    assert.deepEqual(await heard(financeOwner), [[finance.id, 'Hello Finance']]);
    console.log('P1-13_WORKSPACES PASS two workspaces keep separate settings and secrets, in the API and inside the extension');

    // Validation against the manifest schema: wrong types are refused, nothing is stored.
    for (const values of [{ enabled: 'false' }, { retries: 'abc' }, { retries: 2.5 }, { retries: 99 }, { greeting: 42 },
      { unknownKey: 'x' }, { apiKey: 123 }]) {
      assert.equal((await rpc(corpOwner, 'settings/set', { extension: EXT, values })).status, 400, JSON.stringify(values));
    }
    assert.deepEqual((await rpc(corpOwner, 'settings/get', { extension: EXT })).body.values, corpSettings, 'refused writes change nothing');
    const coerced = await rpc(corpOwner, 'settings/set', { extension: EXT, values: { retries: '7', enabled: false } });
    assert.deepEqual([coerced.body.values.retries, coerced.body.values.enabled], [7, false], 'a numeric string is coerced; a real boolean is kept');
    const cleared = await rpc(corpOwner, 'settings/set', { extension: EXT, values: { greeting: null, apiKey: null } });
    assert.deepEqual([cleared.body.values.greeting, cleared.body.values.apiKey], ['Hello', { set: false }], 'null restores the default and removes a secret');
    assert.equal((await hello(financeOwner)).apiKey, 'finance-key', 'clearing Corp leaves Finance alone');
    // Inherited Object properties are not declared settings (review finding 4).
    // (The RPC layer already drops a '__proto__' key, so the kernel check is also run directly below.)
    for (const key of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const response = await fetch(`${base}/settings/set`, { method: 'POST', headers: { 'content-type': 'application/json', ...as(corpOwner) },
        body: `{"json":{"extension":"${EXT}","values":{"${key}":"x"}}}` });
      assert.equal(response.status, 400, key);
    }
    const schema = gateway.kernel.getSettingsSchema(EXT);
    for (const raw of ['{"__proto__":"x"}', '{"constructor":"x"}', '{"toString":"x"}']) {
      assert.throws(() => coerceSettingValues(EXT, schema, JSON.parse(raw)), SettingsValidationError, raw);
    }
    assert.deepEqual(Object.keys((await rpc(corpOwner, 'settings/get', { extension: EXT })).body.values).sort(),
      ['apiKey', 'enabled', 'greeting', 'retries'], 'nothing inherited was stored');
    console.log('P1-13_VALIDATION PASS "false", non-numbers, out-of-range, unknown and inherited keys are refused; null clears');

    // Review finding 1: an extension's secret scope is admin-only to write, like settings.set, in every workspace.
    const member = await signUp('member@corp.test');
    const memberInvite = await (await fetch(`${base}/auth/organization/invite-member`,
      json({ organizationId: corp.id, email: 'member@corp.test', role: 'member' }, as(corpOwner)))).json() as { id: string };
    assert.equal((await fetch(`${base}/auth/organization/accept-invitation`, json({ invitationId: memberInvite.id }, as(member)))).status, 200);
    assert.equal((await fetch(`${base}/auth/organization/set-active`, json({ organizationId: corp.id }, as(member)))).status, 200);
    const secretScope = (workspaceId: string) => ({ kind: 'engine', workspaceId, subjectId: EXT });
    for (const [path, input] of [
      ['vault/put', { scope: secretScope(corp.id), name: SECRET_NAME, value: 'member-key' }],
      ['vault/rotate', { scope: secretScope(corp.id), name: SECRET_NAME, value: 'member-key' }],
      ['vault/put', { scope: secretScope(corp.id), name: 'SEC_OTHER', value: 'member-key' }],
      ['vault/put', { scope: secretScope(finance.id), name: SECRET_NAME, value: 'member-key' }],
      ['settings/set', { extension: EXT, values: { apiKey: 'member-key' } }],
    ] as const) {
      assert.equal((await rpc(member, path, input)).status, 403, `member ${path} ${input.scope?.workspaceId ?? ''}`);
    }
    assert.equal((await hello(member)).apiKey, null, 'the cleared Corp secret was not replaced by a member');
    assert.equal(await gateway.vault.get(secretScope(finance.id) as any, SECRET_NAME), 'finance-key');
    // Members keep their ordinary vault rights; admins may write the extension scope of their own workspace only.
    assert.equal((await rpc(member, 'vault/put', { scope: { kind: 'workspace', workspaceId: corp.id }, name: 'MEMBER_NOTE', value: 'ok' })).status, 200);
    assert.equal((await rpc(financeOwner, 'vault/put', { scope: secretScope(finance.id), name: SECRET_NAME, value: 'finance-key-2' })).status, 200);
    assert.equal((await rpc(financeOwner, 'vault/put', { scope: secretScope(corp.id), name: SECRET_NAME, value: 'x' })).status, 403,
      'a Finance admin cannot write Corp extension secrets');
    console.log('P1-13_SECRET_SCOPE PASS extension secret scopes are admin-only writes in their own workspace');

    // Engine memory callback tokens are the Gateway's alone: no member, admin or owner may set, rotate or delete one.
    const memorySubjects = [`engine-dsh/${'a'.repeat(32)}`, 'engine-hermes/default'];
    for (const [who, token, workspace] of [['member', member, corp.id], ['owner', corpOwner, corp.id], ['admin', financeOwner, finance.id]] as const) {
      for (const subjectId of memorySubjects) {
        const scope = { kind: 'engine', workspaceId: workspace, subjectId };
        for (const [path, input] of [
          ['vault/put', { scope, name: 'NEO_MEMORY_TOKEN', value: 'f'.repeat(64) }],
          ['vault/rotate', { scope, name: 'NEO_MEMORY_TOKEN', value: 'f'.repeat(64) }],
          ['vault/delete', { scope, name: 'NEO_MEMORY_TOKEN' }],
        ] as const) {
          assert.equal((await rpc(token, path, input)).status, 403, `${who} ${path} ${subjectId}`);
        }
        assert.equal(await gateway.vault.get(scope as any, 'NEO_MEMORY_TOKEN'), undefined, `${who} wrote no memory token`);
      }
    }
    console.log('P1-13_MEMORY_TOKEN PASS members, admins and owners cannot write engine memory tokens');
  } finally {
    await gateway.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('P1-13 desktop: pre-P1-13 settings move into the desktop workspace without loss, and behave as before', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nmh-p113-desktop-'));
  const extensionsDir = await fixture(root);
  const options = { databaseFile: join(root, 'state/gateway.db'), dataDir: join(root, 'data'), extensionsDir, mode: 'desktop' as const };
  try {
    // An install from before P1-13: workspace-less settings in the legacy table and the 'default' vault scope.
    const before = await startGateway(options);
    await (before.db as any).setExtensionSettings(EXT, { greeting: 'Legacy hello', retries: 4 });
    await before.vault.put({ kind: 'engine', workspaceId: 'default', subjectId: EXT }, SECRET_NAME, 'legacy-key');
    await before.close();

    const gateway = await startGateway(options);
    try {
      const token = gateway.desktopToken!;
      const base = `http://127.0.0.1:${gateway.port}`;
      const rpc = async (path: string, input: unknown) => {
        const response = await fetch(`${base}/${path}`, json({ json: input }, { authorization: `Bearer ${token}` }));
        return { status: response.status, body: response.ok ? (await response.json() as { json: any }).json : undefined };
      };
      assert.equal((await rpc('extensions/enable', { id: EXT })).status, 200);
      assert.deepEqual((await rpc('settings/get', { extension: EXT })).body.values,
        { greeting: 'Legacy hello', enabled: true, retries: 4, apiKey: { set: true } }, 'legacy values and secret survive');
      const hello = async () => (await fetch(`${base}/x/${EXT}/hello`, { headers: { authorization: `Bearer ${token}` } })).json() as Promise<any>;
      assert.equal((await hello()).apiKey, 'legacy-key');
      assert.deepEqual(await (gateway.db as any).listLegacyExtensionSettings(), [], 'the legacy rows were moved');
      assert.equal(await gateway.vault.get({ kind: 'engine', workspaceId: 'default', subjectId: EXT }, SECRET_NAME), undefined);
      // Desktop behaves as before: a change shows up in requests and in background work alike.
      assert.equal((await rpc('settings/set', { extension: EXT, values: { greeting: 'Desktop hello' } })).status, 200);
      assert.equal((await hello()).greeting, 'Desktop hello');
      assert.equal(((await gateway.kernel.invokeRoute(`/x/${EXT}/hello`, 'GET')) as any).greeting, 'Desktop hello',
        'outside a request, desktop still reads its one workspace');
      assert.equal((await rpc('settings/set', { extension: EXT, values: { enabled: 'false' } })).status, 400, '"false" is refused on desktop too');
    } finally {
      await gateway.close();
    }
    // A second start finds nothing left to migrate and keeps the values.
    const again = await startGateway(options);
    try {
      assert.equal((await again.kernel.getSettings(EXT)).values.greeting, 'Desktop hello');
      assert.equal((await again.kernel.getSettings(EXT)).values.apiKey, 'legacy-key');
    } finally {
      await again.close();
    }
    console.log('P1-13_DESKTOP PASS legacy settings and secrets migrate once into the desktop workspace; desktop reads are unchanged');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('P1-13 server: pre-P1-13 settings move into the bootstrap workspace (kept until one exists)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nmh-p113-server-legacy-'));
  const extensionsDir = await fixture(root);
  const options = { databaseFile: join(root, 'state/gateway.db'), dataDir: join(root, 'data'), extensionsDir,
    mode: 'server' as const, signup: 'open' as const };
  try {
    // An upgraded deployment: workspace-less rows in the legacy table and the 'default' vault scope.
    const seeded = await startGateway(options);
    await (seeded.db as any).setExtensionSettings(EXT, { greeting: 'Legacy hello', retries: 4 });
    await seeded.vault.put({ kind: 'engine', workspaceId: 'default', subjectId: EXT }, SECRET_NAME, 'legacy-key');
    await seeded.close();

    // No workspace exists yet: nothing is lost, the rows wait.
    const first = await startGateway(options);
    let corp: { id: string }; let finance: { id: string }; let owner: string;
    try {
      assert.equal((await (first.db as any).listLegacyExtensionSettings()).length, 1, 'legacy rows kept without a workspace');
      const base = `http://127.0.0.1:${first.port}`;
      const response = await fetch(`${base}/auth/sign-up/email`, json({ email: 'owner@corp.test', password: 'Member!Pass123', name: 'x' }));
      owner = (await response.json() as { token: string }).token;
      corp = await (await fetch(`${base}/auth/organization/create`, json({ name: 'Corp', slug: 'corp' }, { authorization: `Bearer ${owner}` }))).json() as { id: string };
      finance = await (await fetch(`${base}/auth/organization/create`,
        json({ name: 'Finance', slug: 'finance', keepCurrentActiveOrganization: true }, { authorization: `Bearer ${owner}` }))).json() as { id: string };
      // The first workspace appeared after start: the next settings access moves the rows, no restart needed.
      const got = await fetch(`${base}/settings/get`, json({ json: { extension: EXT } }, { authorization: `Bearer ${owner}` }));
      assert.deepEqual((await got.json() as any).json.values,
        { greeting: 'Legacy hello', enabled: true, retries: 4, apiKey: { set: true } }, 'migrated on first access');
      assert.deepEqual(await (first.db as any).listLegacyExtensionSettings(), [], 'the legacy rows were moved without a restart');
    } finally {
      await first.close();
    }

    const gateway = await startGateway(options);
    try {
      const bootstrap = (await (gateway.auth as any).kysely.selectFrom('organization').select('id').orderBy('createdAt').executeTakeFirst()).id;
      assert.equal(bootstrap, corp.id, 'Corp is the bootstrap workspace');
      assert.deepEqual(await (gateway.db as any).listLegacyExtensionSettings(), [], 'the legacy rows were moved');
      assert.deepEqual(await gateway.kernel.getSettings(EXT, corp.id).then((r) => r.sanitized),
        { greeting: 'Legacy hello', enabled: true, retries: 4, apiKey: { set: true } }, 'legacy values and secret survive in Corp');
      assert.equal(await gateway.vault.get({ kind: 'engine', workspaceId: corp.id, subjectId: EXT }, SECRET_NAME), 'legacy-key');
      assert.equal(await gateway.vault.get({ kind: 'engine', workspaceId: 'default', subjectId: EXT }, SECRET_NAME), undefined);
      assert.deepEqual(await gateway.kernel.getSettings(EXT, finance.id).then((r) => r.sanitized),
        { greeting: 'Hello', enabled: true, retries: 3, apiKey: { set: false } }, 'other workspaces do not inherit them');
      // Reachable through the API by the bootstrap workspace's owner.
      const got = await fetch(`http://127.0.0.1:${gateway.port}/settings/get`, json({ json: { extension: EXT } }, { authorization: `Bearer ${owner}` }));
      assert.equal((await got.json() as any).json.values.greeting, 'Legacy hello');
    } finally {
      await gateway.close();
    }
    console.log('P1-13_SERVER_MIGRATION PASS legacy settings wait for, then move into, the bootstrap workspace (on first access, and they persist)');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
