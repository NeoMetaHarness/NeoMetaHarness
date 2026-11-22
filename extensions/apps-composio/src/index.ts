import { join } from 'node:path';
import { defineExtension, type AppsRegistry, type McpProjectionBridge } from '@neometaharness/kernel';
import type { VaultService } from '@neometaharness/vault';
import { ComposioProvider, type ComposioSettings } from './composio.js';
import { AppsProjection } from './projection.js';
export default defineExtension({
  async activate(ctx) {
    const apps = ctx.inject<AppsRegistry>('appsRegistry'); const bridge = ctx.inject<McpProjectionBridge>('appsMcpBridge');
    const vault = ctx.inject<VaultService>('vault'); const gateway = ctx.inject<() => string>('gatewayUrl');
    const runInWorkspace = ctx.inject<<T>(workspace: string, work: () => T | Promise<T>) => Promise<T>>('appsRunInWorkspace');
    const home = ctx.inject<string>('extensionDataDir');
    if (!apps || !bridge || !vault || !gateway || !home || !runInWorkspace) throw new Error('Connected apps require Gateway registry, vault and MCP services');
    const provider = new ComposioProvider(() => ctx.inject<ComposioSettings>('settings') ?? {},
      join(home, 'apps-composio', 'accounts'), ctx.inject<typeof fetch>('appsHttpClient'), gateway);
    await provider.load();
    for (const binding of provider.accounts.bindings()) await bridge.bindWorkspace(binding.engine, binding.profile, binding.workspaceId);
    const unregister = apps.register(provider); const projection = new AppsProjection(vault, apps, gateway, runInWorkspace);
    ctx.effect(() => async () => { unregister(); provider.close(); await bridge.detach(projection); });
    await bridge.attach(projection);
    ctx.route('mcp/action', ({ body }) => projection.action(body as Parameters<AppsProjection['action']>[0]));
    ctx.health(() => ({ ok: true })); // Unconfigured and remote outages remain recoverable.
  },
});
