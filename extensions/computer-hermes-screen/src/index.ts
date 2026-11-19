import { defineExtension } from '@neometaharness/kernel';
import type { ComputerRegistry } from '@neometaharness/computers';
import type { VaultService } from '@neometaharness/vault';
import { HermesScreenProvider, type HermesScreenBridge } from './provider.js';

export default defineExtension({
  activate(ctx) {
    const computers = ctx.inject<ComputerRegistry>('computers');
    const vault = ctx.inject<VaultService>('vault');
    if (!computers || !vault) throw new Error('Hermes screen requires computers and vault');
    // Resolve on each attach so Hermes can be enabled after the screen extension.
    const provider = new HermesScreenProvider(vault, () => ctx.inject<HermesScreenBridge>('hermesScreen'));
    ctx.effect(() => {
      const unregister = computers.registerProvider('computer-hermes-screen', provider);
      return async () => { provider.close(); await unregister(); };
    });
    ctx.health(() => ({ ok: true }));
  },
});
