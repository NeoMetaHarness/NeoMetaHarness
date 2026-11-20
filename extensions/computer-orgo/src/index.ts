import { defineExtension } from '@neometaharness/kernel';
import type { ComputerRegistry } from '@neometaharness/computers';
import type { VaultService } from '@neometaharness/vault';
import { OrgoComputerProvider, type OrgoClient } from './provider.js';

export default defineExtension({
  activate(ctx) {
    const computers = ctx.inject<ComputerRegistry>('computers');
    const vault = ctx.inject<VaultService>('vault');
    if (!computers || !vault) throw new Error('Orgo requires computer registry and vault');
    const settingsFor = ctx.inject<(workspaceId: string) => Promise<Record<string, unknown>>>('settingsFor');
    if (!settingsFor) throw new Error('Orgo requires workspace-scoped extension settings');
    const provider = new OrgoComputerProvider(vault, settingsFor, ctx.inject<OrgoClient>('orgoClient'));
    ctx.effect(() => {
      const unregister = computers.registerProvider('computer-orgo', provider);
      return async () => { await unregister(); await provider.close(); };
    });
    ctx.health(() => ({ ok: true }));
  },
});
