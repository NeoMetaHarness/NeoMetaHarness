import { defineExtension } from '@neometaharness/kernel';
import { HermesRuntime } from './runtime.js';

export default defineExtension({
  async activate(ctx) {
    const service = new HermesRuntime();
    await service.start();
    ctx.provide('agentRuntime', service);
    ctx.effect(() => () => service.disconnect());
    ctx.health(() => ({ ok: service.connected, pid: service.pid }));

    ctx.route('profiles/list', () => service.listProfiles());
    ctx.route('profiles/create', ({ body }) => service.createProfile((body as { name: string }).name));
    ctx.route('profiles/delete', ({ body }) => service.deleteProfile((body as { name: string }).name));
    ctx.route('runs/start', ({ body }) => {
      const { profile, input } = body as { profile: string; input: string };
      return service.startRun(profile, input);
    });
    ctx.route('runs/events', ({ body }) => {
      const { profile, runId, signal } = body as { profile: string; runId: string; signal?: AbortSignal };
      return service.events(profile, runId, signal);
    });
    ctx.route('runs/approve', ({ body }) => {
      const { profile, runId, choice } = body as { profile: string; runId: string; choice: 'once' | 'session' | 'deny' };
      return service.approve(profile, runId, choice);
    });
    ctx.route('runs/stop', ({ body }) => {
      const { profile, runId } = body as { profile: string; runId: string };
      return service.stopRun(profile, runId);
    });
    ctx.route('cron/list', () => service.listCron());
    ctx.route('cron/create', ({ body }) => {
      const { prompt, schedule } = body as { prompt: string; schedule: string };
      return service.createCron(prompt, schedule);
    });
    ctx.route('cron/delete', ({ body }) => service.deleteCron((body as { id: string }).id));
  },
});
