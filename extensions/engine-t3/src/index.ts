import { defineExtension } from '@neometaharness/kernel';
import { T3ControlPlane } from './client.js';

export default defineExtension({
  async activate(ctx) {
    const service = new T3ControlPlane();
    ctx.provide('codingControlPlane', service);
    ctx.effect(() => () => service.disconnect());
    ctx.health(() => ({ ok: service.connected }));

    ctx.route('create', ({ body }) => service.createThread(body as Parameters<typeof service.createThread>[0]));
    ctx.route('send', ({ body }) => service.sendMessage(body as Parameters<typeof service.sendMessage>[0]));
    ctx.route('events', ({ body }) => {
      const input = body as { threadId: string; signal?: AbortSignal };
      return service.subscribeThread(input.threadId, input.signal);
    });
    ctx.route('approval', ({ body }) => service.respond(body as Parameters<typeof service.respond>[0]));
    ctx.route('settle', ({ body }) => service.settle((body as { threadId: string }).threadId));
    ctx.route('stop', ({ body }) => service.stop(body as Parameters<typeof service.stop>[0]));
    ctx.route('diff', ({ body }) => service.diff(body as Parameters<typeof service.diff>[0]));
    ctx.route('rollback', ({ body }) => service.rollback(body as Parameters<typeof service.rollback>[0]));
    ctx.route('providers/list', () => service.listProviders());
    ctx.route('threads/list', () => service.listThreads());

    if (process.env.NMH_T3_URL && process.env.NMH_T3_SCOPED_SESSION) {
      await service.connect(process.env.NMH_T3_URL, process.env.NMH_T3_SCOPED_SESSION);
    }
  },
});
