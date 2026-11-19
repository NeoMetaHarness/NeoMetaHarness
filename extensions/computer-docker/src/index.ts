import { defineExtension } from '@neometaharness/kernel';
import type { ComputerRegistry } from '@neometaharness/computers';
import type { VaultService } from '@neometaharness/vault';
import { DockerComputerProvider } from './provider.js';

export default defineExtension({
  activate(ctx) {
    const computers = ctx.inject<ComputerRegistry>('computers');
    const vault = ctx.inject<VaultService>('vault');
    if (!computers || !vault) throw new Error('Docker desktop requires computer registry and vault');
    const provider = new DockerComputerProvider(vault);
    ctx.effect(() => {
      const unregister = computers.registerProvider('computer-docker', provider);
      return async () => { await unregister(); await provider.close(); };
    });
    ctx.health(() => ({ ok: true }));
  },
});
