import { defineExtension } from '@neometaharness/kernel';
import type { ComputerRegistry } from '@neometaharness/computers';
import { BoatComputerProvider, type BoatSettings, type BoatHttp } from './provider.js';

export default defineExtension({
  activate(ctx) {
    const computers = ctx.inject<ComputerRegistry>('computers');
    const settingsFor = ctx.inject<(workspaceId: string) => Promise<BoatSettings>>('settingsFor');
    if (!computers || !settingsFor) throw new Error('Boat requires computer registry and workspace settings');
    const provider = new BoatComputerProvider(settingsFor, ctx.inject<BoatHttp>('computerBoatHttp'));
    ctx.effect(() => {
      const unregister = computers.registerProvider('computer-boat', provider);
      return async () => { await unregister(); await provider.close(); };
    });
    ctx.route('snapshot', async ({ body }) => {
      const { id, workspaceId } = (body as { id?: unknown; workspaceId?: unknown } | undefined) ?? {};
      if (typeof id !== 'string' || typeof workspaceId !== 'string') throw new Error('Authenticated workspace and managed computer required');
      return provider.saveSnapshot(id, workspaceId);
    });
    ctx.health(() => ({ ok: true }));
  },
});
