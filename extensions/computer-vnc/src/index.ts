import { defineExtension } from '@neometaharness/kernel';
import type { ComputerRegistry } from '@neometaharness/computers';
import type { VaultService } from '@neometaharness/vault';
import { VncComputerProvider } from './provider.js';

export default defineExtension({
  activate(ctx) {
    const registry = ctx.inject<ComputerRegistry>('computers'), vault = ctx.inject<VaultService>('vault');
    if (!registry || !vault) throw new Error('VNC requires the computer registry and vault');
    const provider = new VncComputerProvider(vault);
    ctx.effect(() => {
      const unregister = registry.registerProvider('computer-vnc', provider);
      return async () => { provider.close(); await unregister(); };
    });
    ctx.health(() => ({ ok: true }));
  },
});
