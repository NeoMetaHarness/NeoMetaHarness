import { defineExtension } from '@neometaharness/kernel';
import type { ComputerRegistry } from '@neometaharness/computers';
import { CommandLocalDriver } from './command-driver.js';
import { LOCAL_DESKTOP_ID, LocalComputerProvider, type LocalDriverFactory } from './provider.js';

export default defineExtension({
  activate(ctx) {
    const computers = ctx.inject<ComputerRegistry>('computers');
    if (!computers) throw new Error('Missing computer registry');
    const factory = ctx.inject<LocalDriverFactory>('computerLocalDriverFactory') ?? (() => new CommandLocalDriver());
    const provider = new LocalComputerProvider(factory);
    ctx.effect(() => {
      const unregister = computers.registerProvider('computer-local', provider);
      return async () => { provider.close(); await unregister(); };
    });
    ctx.route('status', () => provider.status());
    ctx.route('consent', async ({ method, body }) => {
      if (method !== 'POST' || !body || typeof body !== 'object' || typeof (body as { enabled?: unknown }).enabled !== 'boolean') {
        throw new Error('Invalid owner consent request');
      }
      const enabled = (body as { enabled: boolean }).enabled;
      const result = provider.setEnabled(enabled);
      if (!enabled) await computers.release(LOCAL_DESKTOP_ID);
      return result;
    });
    ctx.health(() => ({ ok: true }));
  },
});
