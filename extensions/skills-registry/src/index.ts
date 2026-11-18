import { defineExtension, type SkillsBridge } from '@neometaharness/kernel';
import { join } from 'node:path';
import { SkillRegistry } from './registry.js';

export default defineExtension({
  async activate(ctx) {
    const root = ctx.inject<string>('extensionDataDir');
    const bridge = ctx.inject<SkillsBridge>('skillsBridge');
    if (!root || !bridge) throw new Error('Skill registry needs storage and engine bridge');
    const registry = new SkillRegistry(join(root, 'skills-registry'));
    await registry.start();
    await bridge.attach(registry);
    ctx.provide('skillRegistry', registry);
    ctx.effect(() => () => bridge.detach(registry));
    ctx.health(() => ({ ok: true }));
    ctx.route('list', () => registry.list());
    ctx.route('get', ({ body }) => registry.get((body as { name: string }).name));
    ctx.route('import', ({ body }) => registry.import(body as Parameters<typeof registry.import>[0]));
    ctx.route('versions', ({ body }) => registry.versions((body as { name: string }).name));
    ctx.route('diff', ({ body }) => {
      const { name, from, to } = body as { name: string; from: number; to: number };
      return registry.diff(name, from, to);
    });
    ctx.route('rollback', ({ body }) => {
      const { name, version } = body as { name: string; version: number };
      return registry.rollback(name, version);
    });
    ctx.route('sync', async ({ body }) => {
      const profile = (body as { profile: string }).profile;
      return bridge.sync(profile);
    });
    ctx.route('assign', ({ body }) => registry.assign(body as Parameters<typeof registry.assign>[0]));
    ctx.route('assignments', () => registry.listAssignments());
    ctx.route('evaluate', ({ body }) => registry.evaluate((body as { name: string }).name, async () => {
      const modelHub = ctx.inject<{ resolve(role: 'eval'): Promise<{ baseUrl: string; model: string; apiKey?: string }> }>('modelHub');
      if (!modelHub) throw new Error('Eval model hub is unavailable');
      return modelHub.resolve('eval');
    }));
    ctx.route('override', ({ body }) => {
      const { name, actor, reason } = body as { name: string; actor: string; reason: string };
      return registry.override(name, actor, reason);
    });
    ctx.route('ceiling', ({ body }) => {
      const { engine, targetId } = body as { engine: 'hermes' | 'dsh'; targetId: string };
      return registry.ceiling(engine, targetId);
    });
    ctx.route('ceiling/set', ({ body }) => {
      const { engine, targetId, ceiling } = body as { engine: 'hermes' | 'dsh'; targetId: string; ceiling: 'suggest' | 'auto-low' | 'auto' };
      return registry.setCeiling(engine, targetId, ceiling);
    });
    ctx.route('hub/scan', ({ body }) => registry.scanHub(body as Parameters<typeof registry.scanHub>[0]));
    ctx.route('hub/approve', ({ body }) => {
      const { id, actor, reason } = body as { id: string; actor: string; reason: string };
      return registry.approveHub(id, actor, reason);
    });
    ctx.route('hub/install', ({ body }) => registry.installHub(body as Parameters<typeof registry.installHub>[0]));
  },
});
