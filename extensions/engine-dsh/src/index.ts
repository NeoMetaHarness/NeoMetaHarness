import { defineExtension } from '@neometaharness/kernel';
import type { VaultService } from '@neometaharness/vault';
import type { ComputerRegistry } from '@neometaharness/computers';
import { join } from 'node:path';
import { DshAgentRuntime } from './runtime.js';

export default defineExtension({
  activate(ctx) {
    const vault = ctx.inject<VaultService>('vault');
    const dataDir = ctx.inject<string>('extensionDataDir');
    const computers = ctx.inject<ComputerRegistry>('computers');
    if (!vault || !dataDir) throw new Error('DSH requires Gateway vault and extension storage');
    const runtime = new DshAgentRuntime(vault, join(dataDir, 'engine-dsh'), computers);
    ctx.provide('dshAgentRuntime', runtime);
    ctx.effect(() => () => runtime.stop());
    ctx.health(() => ({ ok: true }));
    ctx.route('create', ({ body }) => runtime.create(body as Parameters<typeof runtime.create>[0]));
    ctx.route('prompt', ({ body }) => runtime.prompt(body as Parameters<typeof runtime.prompt>[0]));
    ctx.route('events', ({ body }) => runtime.events(body as Parameters<typeof runtime.events>[0]));
    ctx.route('wait', ({ body }) => runtime.wait(body as Parameters<typeof runtime.wait>[0]));
    ctx.route('cancel', ({ body }) => runtime.cancel(body as Parameters<typeof runtime.cancel>[0]));
    ctx.route('shutdown', ({ body }) => runtime.shutdown(body as Parameters<typeof runtime.shutdown>[0]));
  },
});
