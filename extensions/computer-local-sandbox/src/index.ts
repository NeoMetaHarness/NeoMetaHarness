import { defineExtension } from '@neometaharness/kernel';
import type { ComputerRegistry } from '@neometaharness/computers';
import { HeadlessChromeProvider } from '../../computer-headless-chrome/src/index.js';

// Each provider instance owns its own Chrome processes and isolated user-data directories.
// On Windows this acts as a disposable desktop until Hermes' Xvnc screen is available.
export default defineExtension({
  activate(ctx) {
    const computers = ctx.inject<ComputerRegistry>('computers');
    if (!computers) throw new Error('Missing computer registry');
    const provider = new HeadlessChromeProvider();
    ctx.effect(() => computers.registerProvider('computer-local-sandbox', provider));
    ctx.health(() => ({ ok: true }));
  },
});
