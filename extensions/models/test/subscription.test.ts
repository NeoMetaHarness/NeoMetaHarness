import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import type { VaultService } from '@neometaharness/vault';
import type { ExtensionContext } from '@neometaharness/kernel';
import extension from '../src/index.js';
import { ModelHub } from '../src/hub.js';

const subscription = {
  id: 'chatgpt', kind: 'subscription' as const, vendor: 'openai' as const,
  engines: { hermes: { status: 'signed-in', profile: 'default' }, t3: { status: 'signed-in' } },
  accountEmail: 'example@example.invalid', status: 'signed-in',
} as const;
const apiError = /DeepSeek Harness and the super agent need an API key or a local model/;

test('subscription storage is workspace-scoped and keeps only metadata', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'neo-subscription-'));
  try {
    const vault = {} as VaultService;
    const hub = new ModelHub(vault, temp);
    const input = { ...subscription, apiKey: 'test-ignored', engines: {
      ...subscription.engines, hermes: { ...subscription.engines.hermes, token: 'test-ignored' },
    } };
    await hub.saveProvider(input, 'team');
    const raw = await readFile(join(temp, 'models', 'workspaces', 'team', 'settings.json'), 'utf8');
    assert.deepEqual(JSON.parse(raw).providers, [{ ...subscription, name: 'chatgpt' }]);
    assert.doesNotMatch(raw, /apiKey|hasKey|token|test-ignored/);
    const restored = new ModelHub(vault, temp);
    assert.deepEqual((await restored.state('team')).providers, [{ ...subscription, name: 'chatgpt' }]);
    assert.deepEqual((await restored.state()).providers, []);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('Hermes uses openai-codex and removes the previous API projection', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'neo-subscription-projection-'));
  try {
    const hub = new ModelHub({ get: async () => undefined } as unknown as VaultService, temp);
    hub.setActive(true);
    await hub.saveProvider({ id: 'local', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' });
    await hub.setRole({ role: 'default', providerId: 'local', model: 'local-model' });
    const home = join(temp, 'profile');
    await hub.projectHermes('default', home);
    assert.match(await readFile(join(home, '.env'), 'utf8'), /NEO_MODEL_API_KEY/);
    await hub.saveProvider(subscription);
    await hub.setRole({ role: 'default', providerId: subscription.id, model: 'gpt-5' });
    await hub.projectHermes('default', home);
    const config = parse(await readFile(join(home, 'config.yaml'), 'utf8'));
    assert.deepEqual(config.model, { provider: 'openai-codex', default: 'gpt-5' });
    assert.equal(config.providers.neo_model, undefined);
    assert.doesNotMatch(await readFile(join(home, '.env'), 'utf8'), /NEO_MODEL_API_KEY/);
    await hub.setOverride({ profile: 'custom', providerId: subscription.id, model: 'gpt-5-custom' });
    await assert.rejects(hub.projectHermes('custom', join(temp, 'custom')), /not available in Hermes/);
    await hub.saveProvider({ ...subscription, engines: { ...subscription.engines, hermes: { status: 'approved', profile: 'custom' } } });
    await hub.projectHermes('custom', join(temp, 'custom'));
    assert.equal(parse(await readFile(join(temp, 'custom', 'config.yaml'), 'utf8')).model.default, 'gpt-5-custom');
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('API role binding and resolution refuse subscriptions', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'neo-subscription-roles-'));
  try {
    const hub = new ModelHub({} as VaultService, temp);
    hub.setActive(true);
    await hub.saveProvider(subscription);
    for (const role of ['coding', 'eval'] as const) {
      await assert.rejects(hub.setRole({ role, providerId: subscription.id, model: 'gpt-5' }), apiError);
    }
    await hub.setOverride({ profile: 'custom', providerId: subscription.id, model: 'gpt-5' });
    await assert.rejects(hub.resolve('coding', 'custom'), apiError);
    assert.deepEqual((await hub.state()).roles, {});
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('Hermes rejects subscriptions without a supported Hermes sign-in before projection', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'neo-subscription-unsupported-'));
  try {
    const hub = new ModelHub({ get: async () => undefined } as unknown as VaultService, temp);
    hub.setActive(true);
    await hub.saveProvider({ id: 'local', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' });
    await hub.setRole({ role: 'default', providerId: 'local', model: 'local-model' });
    const home = join(temp, 'profile');
    await hub.projectHermes('default', home);
    const original = await readFile(join(home, 'config.yaml'), 'utf8');
    const env = await readFile(join(home, '.env'), 'utf8');
    for (const unsupported of [
      { ...subscription, id: 'claude', vendor: 'anthropic' as const },
      { ...subscription, id: 't3-only', engines: { t3: { status: 'signed-in' as const } } },
      ...(['pending', 'failed', 'error', 'signed-out'] as const).map((status) => ({
        ...subscription, engines: { ...subscription.engines, hermes: { status, profile: 'default' } },
      })),
    ]) {
      await hub.saveProvider(unsupported);
      await hub.setRole({ role: 'default', providerId: unsupported.id, model: 'test-model' });
      await assert.rejects(hub.projectHermes('default', home), /not available in Hermes/);
      assert.equal(await readFile(join(home, 'config.yaml'), 'utf8'), original);
      assert.equal(await readFile(join(home, '.env'), 'utf8'), env);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('invalid subscription statuses are rejected on write and on deployment and workspace load', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'neo-subscription-status-'));
  try {
    const vault = {} as VaultService;
    const hub = new ModelHub(vault, temp);
    const invalid = 'invented-status' as never;
    for (const provider of [
      { ...subscription, status: invalid },
      { ...subscription, engines: { ...subscription.engines, hermes: { status: invalid } } },
      { ...subscription, engines: { ...subscription.engines, t3: { status: invalid } } },
    ]) {
      await assert.rejects(hub.saveProvider(provider), /Invalid subscription status/);
      await hub.saveProvider(subscription);
      await hub.saveProvider(subscription, 'team');
      for (const path of [join(temp, 'models', 'workspaces', 'team', 'settings.json'), join(temp, 'models', 'settings.json')]) {
        const settings = JSON.parse(await readFile(path, 'utf8'));
        settings.providers = [{ ...provider, name: 'chatgpt' }];
        await writeFile(path, JSON.stringify(settings));
      }
      // Deployment is loaded eagerly; a workspace is loaded on demand.
      assert.throws(() => new ModelHub(vault, temp), /Invalid subscription status/);
      await hub.saveProvider(subscription);
      const restored = new ModelHub(vault, temp);
      await assert.rejects(restored.state('team'), /Invalid subscription status/);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('disabling the extension deactivates subscription projection and resolution', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'neo-subscription-disable-'));
  try {
    let hub!: ModelHub;
    const cleanup: Array<() => void | Promise<void>> = [];
    await extension.activate({
      inject: (name: string) => name === 'vault' ? {} : name === 'extensionDataDir' ? temp : undefined,
      provide: (_name: string, value: ModelHub) => { hub = value; },
      effect: (register: () => () => void | Promise<void>) => { cleanup.push(register()); },
      health: () => {}, route: () => {},
    } as unknown as ExtensionContext);
    await hub.saveProvider(subscription);
    await hub.setRole({ role: 'default', providerId: subscription.id, model: 'gpt-5' });
    for (const dispose of cleanup.reverse()) await dispose();
    assert.equal(hub.active, false);
    assert.equal(await hub.projectHermes('default', join(temp, 'profile')), undefined);
    await assert.rejects(hub.resolve('default'), /Model Hub extension is disabled/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
