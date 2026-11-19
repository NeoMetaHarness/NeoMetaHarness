import { defineExtension, type ComputerMcpBridge } from '@neometaharness/kernel';
import type { ComputerRegistry } from '@neometaharness/computers';
import type { VaultService } from '@neometaharness/vault';
import { ComputerProjection } from './projection.js';
export default defineExtension({
  async activate(ctx) {
    const bridge = ctx.inject<ComputerMcpBridge>('computerMcpBridge');
    const computers = ctx.inject<ComputerRegistry>('computers');
    const vault = ctx.inject<VaultService>('vault');
    const gateway = ctx.inject<() => string>('gatewayUrl');
    if (!bridge || !computers || !vault || !gateway) throw new Error('Computer MCP needs Gateway computer, projection and vault services');
    const projection = new ComputerProjection(vault, computers, gateway);
    await bridge.attach(projection);
    ctx.effect(() => () => bridge.detach(projection));
    ctx.route('action', ({ body }) => projection.action(body as Parameters<ComputerProjection['action']>[0]));
    ctx.health(() => ({ ok: true }));
  },
});
