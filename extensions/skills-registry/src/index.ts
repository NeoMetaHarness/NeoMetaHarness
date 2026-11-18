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
  },
});
