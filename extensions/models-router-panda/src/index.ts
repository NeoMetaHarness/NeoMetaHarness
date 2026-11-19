import { join } from 'node:path';
import { defineExtension } from '@neometaharness/kernel';
import type { VaultService } from '@neometaharness/vault';
import type { ModelHub } from '../../models/src/hub.js';
import { PandaRouter } from './router.js';
export default defineExtension({
  async activate(ctx) {
    const hub = ctx.inject<ModelHub>('modelHub');
    const vault = ctx.inject<VaultService>('vault');
    const home = ctx.inject<string>('extensionDataDir');
    if (!hub || !vault || !home) throw new Error('Panda needs Model Hub, vault and storage');
    const router = new PandaRouter(vault, join(home, 'models-router-panda'));
    await router.load();
    ctx.effect(() => {
      const detach = hub.registerRouter(router);
      return async () => { detach(); await router.close(); };
    });
    // Endpoint outages are recoverable: Model Hub keeps serving the direct binding.
    ctx.health(() => ({ ok: true }));
    ctx.route('settings/get', () => router.settings());
    ctx.route('settings/set', ({ body }) => router.configure(body));
    ctx.route('health', () => router.health());
  },
});
