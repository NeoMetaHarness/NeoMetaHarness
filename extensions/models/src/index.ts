import { defineExtension } from '@neometaharness/kernel';
import type { VaultService } from '@neometaharness/vault';
import { join } from 'node:path';
import { ModelHub } from './hub.js';

export default defineExtension({
  activate(ctx) {
    const vault = ctx.inject<VaultService>('vault');
    const dataDir = ctx.inject<string>('extensionDataDir');
    if (!vault || !dataDir) throw new Error('Model Hub needs vault and extension storage');
    const hub = new ModelHub(vault, join(dataDir, 'models'));
    ctx.provide('modelHub', hub);
    hub.setActive(true);
    ctx.effect(() => () => hub.setActive(false));
    ctx.health(() => ({ ok: hub.active }));
    ctx.route('providers/list', () => hub.state().providers);
    ctx.route('providers/put', ({ body }) => hub.saveProvider(body as Parameters<ModelHub['saveProvider']>[0]));
    ctx.route('providers/delete', ({ body }) => hub.deleteProvider((body as { id: string }).id));
    ctx.route('providers/test', ({ body }) => hub.testProvider((body as { id: string }).id));
    ctx.route('roles/get', () => hub.state().roles);
    ctx.route('roles/set', ({ body }) => hub.setRole(body as Parameters<ModelHub['setRole']>[0]));
    ctx.route('override/get', ({ body }) => {
      const profile = (body as { profile: string }).profile;
      return { profile, selection: hub.state().overrides[profile] ?? null };
    });
    ctx.route('override/set', ({ body }) => hub.setOverride(body as Parameters<ModelHub['setOverride']>[0]));
  },
});
