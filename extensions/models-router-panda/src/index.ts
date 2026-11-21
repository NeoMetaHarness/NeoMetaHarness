import { join } from 'node:path';
import { defineExtension } from '@neometaharness/kernel';
import type { VaultService } from '@neometaharness/vault';
import type { ModelHub, WorkspaceDirectory } from '../../models/src/hub.js';
import { PandaRouter } from './router.js';
export default defineExtension({
  async activate(ctx) {
    const hub = ctx.inject<ModelHub>('modelHub');
    const vault = ctx.inject<VaultService>('vault');
    const home = ctx.inject<string>('extensionDataDir');
    if (!hub || !vault || !home) throw new Error('Panda needs Model Hub, vault and storage');
    const router = new PandaRouter(vault, join(home, 'models-router-panda'), ctx.inject<WorkspaceDirectory>('workspaceDirectory'));
    await router.load();
    ctx.effect(() => {
      const detach = hub.registerRouter(router);
      return async () => { detach(); await router.close(); };
    });
    // Endpoint outages are recoverable: Model Hub keeps serving the direct binding.
    ctx.health(() => ({ ok: true }));
    // Gateway calls carry the caller's workspace (P1-13) next to the procedure input.
    const split = (body: unknown): [unknown, string | undefined] => {
      const { workspace, ...input } = (body ?? {}) as { workspace?: unknown };
      return [input, typeof workspace === 'string' ? workspace : undefined];
    };
    ctx.route('settings/get', ({ body }) => router.settings(split(body)[1]));
    ctx.route('settings/set', ({ body }) => { const [input, workspace] = split(body); return router.configure(input, workspace); });
    ctx.route('health', ({ body }) => router.health(split(body)[1]));
  },
});
