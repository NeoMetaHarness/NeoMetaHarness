import { defineExtension } from '@neometaharness/kernel';
import type { ComputerRegistry } from '@neometaharness/computers';
import { BoatComputerProvider, type BoatSettings } from './provider.js';

export default defineExtension({
  activate(ctx) {
    const computers = ctx.inject<ComputerRegistry>('computers');
    const settings = ctx.inject<BoatSettings>('settings');
    if (!computers || !settings) throw new Error('Boat requires computer registry and settings');
    const provider = new BoatComputerProvider(() => settings);
    ctx.effect(() => {
      const unregister = computers.registerProvider('computer-boat', provider);
      return async () => { await unregister(); await provider.close(); };
    });
    ctx.route('snapshot', async ({ body }) => {
      const id = (body as { id?: unknown } | undefined)?.id;
      if (typeof id !== 'string') throw new Error('Managed computer ID required');
      return provider.saveSnapshot(id);
    });
    ctx.health(() => ({ ok: true }));
  },
});
