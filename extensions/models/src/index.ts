import { defineExtension } from '@neometaharness/kernel';
import type { VaultService } from '@neometaharness/vault';
import { join } from 'node:path';
import { ModelHub, type WorkspaceDirectory } from './hub.js';

/** Gateway calls carry the caller's workspace (P1-13); the rest of the body is the procedure input. */
type Scoped<T = Record<string, unknown>> = T & { workspace?: string };
const split = <T>(body: unknown): [T, string | undefined] => {
  const { workspace, ...input } = (body ?? {}) as Scoped;
  return [input as T, typeof workspace === 'string' ? workspace : undefined];
};

export default defineExtension({
  activate(ctx) {
    const vault = ctx.inject<VaultService>('vault');
    const dataDir = ctx.inject<string>('extensionDataDir');
    if (!vault || !dataDir) throw new Error('Model Hub needs vault and extension storage');
    const hub = new ModelHub(vault, join(dataDir, 'models'), ctx.inject<WorkspaceDirectory>('workspaceDirectory'));
    ctx.provide('modelHub', hub);
    hub.setActive(true);
    ctx.effect(() => () => hub.setActive(false));
    ctx.health(() => ({ ok: hub.active }));
    ctx.route('providers/list', async ({ body }) => (await hub.state(split(body)[1])).providers);
    ctx.route('providers/put', ({ body }) => hub.saveProvider(...split<Parameters<ModelHub['saveProvider']>[0]>(body)));
    ctx.route('providers/delete', ({ body }) => {
      const [input, workspace] = split<{ id: string }>(body);
      return hub.deleteProvider(input.id, workspace);
    });
    ctx.route('providers/test', ({ body }) => {
      const [input, workspace] = split<{ id: string }>(body);
      return hub.testProvider(input.id, workspace);
    });
    ctx.route('roles/get', async ({ body }) => (await hub.state(split(body)[1])).roles);
    ctx.route('roles/set', ({ body }) => hub.setRole(...split<Parameters<ModelHub['setRole']>[0]>(body)));
    ctx.route('override/get', async ({ body }) => {
      const [input, workspace] = split<{ profile: string }>(body);
      return { profile: input.profile, selection: (await hub.state(workspace)).overrides[input.profile] ?? null };
    });
    ctx.route('override/set', ({ body }) => hub.setOverride(...split<Parameters<ModelHub['setOverride']>[0]>(body)));
  },
});
