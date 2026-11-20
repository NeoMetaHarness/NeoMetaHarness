import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppsRegistry, type AppApproval } from '@neometaharness/kernel';
import { ComposioProvider } from '../src/composio.js';
import { fakeComposio } from './fake.js';
const temp = await mkdtemp(join(tmpdir(), 'neo-apps-unit-')); const fake = await fakeComposio();
let settings = { endpoint: fake.endpoint, apiKey: 'fake-composio-only' };
let injectedCalls = 0;
const provider = new ComposioProvider(() => settings, join(temp, 'accounts.json'), async (...args) => { injectedCalls++; return fetch(...args); });
const registry = new AppsRegistry(); let pending: AppApproval | undefined;
const detach = registry.register(provider); const gate = registry.attachGate({ async submit(input) { pending = input; return { approval: true }; } });
try {
  await provider.load(); assert.equal((await registry.toolkits('composio'))[0]!.id, 'github');
  const connected = await registry.connect('composio', { toolkit: 'github', authConfigId: 'ac_test', userId: 'neo-test', callbackUrl: 'http://127.0.0.1/oauth' });
  assert.match(connected.redirectUrl, /^https:/);
  await assert.rejects(registry.run({ provider: 'composio', accountId: 'foreign', action: 'GITHUB_DELETE', arguments: {} }), /not connected/);
  const action = { provider: 'composio', accountId: 'ca_test', action: 'GITHUB_DELETE', arguments: { repo: 'fake' } };
  await registry.run(action); assert.equal(pending!.destructive, true);
  assert.equal(fake.calls.filter(c => c.path.includes('execute')).length, 0);
  await pending!.execute(); assert.equal(fake.calls.filter(c => c.path.includes('execute')).length, 1);
  await registry.run(action); settings = { ...settings, apiKey: 'changed-fake-key' };
  await assert.rejects(pending!.execute(), /settings changed/); settings.apiKey = 'fake-composio-only';
  await registry.run(action); detach(); await assert.rejects(pending!.execute(), /expired/);
  fake.setFail(true); await assert.rejects(provider.toolkits(), e => !String(e).includes('fake-composio-only'));
  assert.ok(injectedCalls > 0);
  console.log('APPS_COMPOSIO_UNIT PASS injected_http=true fake_only=true OAuth=true conservative_policy=true immutable_approval=true rotation_invalidates=true disable_revokes=true errors_redacted=true');
} finally { gate(); provider.close(); await fake.close(); await rm(temp, { recursive: true, force: true }); }
