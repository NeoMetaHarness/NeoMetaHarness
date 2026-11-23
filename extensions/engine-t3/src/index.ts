import { defineExtension } from '@neometaharness/kernel';
import { T3ControlPlane } from './client.js';
import { installedT3, T3Installer, type T3InstallStatus } from './install.js';
import { T3LocalRuntime } from './runtime.js';

interface T3Settings { existingServerUrl?: string; scopedSession?: string }

export default defineExtension({
  async activate(ctx) {
    const service = new T3ControlPlane();
    const enginesDir = ctx.inject<string>('enginesDir');
    const settings = ctx.inject<T3Settings>('settings') ?? {};
    const externalUrl = process.env.NMH_T3_URL?.trim() || settings.existingServerUrl?.trim();
    const externalSession = process.env.NMH_T3_SCOPED_SESSION?.trim() || settings.scopedSession?.trim();
    const executable = externalUrl ? undefined : installedT3(enginesDir);
    const local = executable && enginesDir ? new T3LocalRuntime(service, executable, enginesDir) : undefined;
    let reason = externalUrl
      ? externalSession ? `Connecting to T3 at ${externalUrl}…` : 'An existing T3 server needs a scoped session in Settings.'
      : executable ? 'Starting the local T3 server…' : "T3 isn't installed yet.";
    let connecting: Promise<void> | undefined;
    const connectExternal = () => {
      if (!externalUrl || !externalSession || service.connected) return Promise.resolve();
      if (!connecting) {
        reason = `Connecting to T3 at ${externalUrl}…`;
        connecting = service.connect(externalUrl, externalSession).then(() => { reason = ''; })
          .catch((error: unknown) => {
            reason = `Couldn't reach T3 at ${externalUrl}. ${error instanceof Error ? error.message : String(error)}`;
            throw error;
          }).finally(() => { connecting = undefined; });
      }
      return connecting;
    };
    const installer = new T3Installer(enginesDir, () => {
      void ctx.reactivate().catch((error) => console.error('T3 restart after install failed', error));
    });
    const status = (): T3InstallStatus => {
      if (externalUrl) return { state: 'ready', message: reason || 'Connected to the existing T3 server.',
        connected: service.connected, external: true };
      if (executable) return { state: 'ready', message: local?.reason || 'T3 is ready.', connected: service.connected };
      return installer.current();
    };

    ctx.provide('codingControlPlane', service);
    ctx.effect(() => async () => {
      installer.cancel();
      await (local ? local.stop() : service.disconnect());
    });
    ctx.health(() => ({ ok: service.connected, ...(service.connected ? {} : { reason: local?.reason || reason }) }));

    ctx.route('install/status', () => status());
    ctx.route('install/start', () => externalUrl || executable ? status() : installer.start());
    ctx.route('runtime/start', async () => {
      if (externalUrl) await connectExternal().catch(() => {});
      else if (local) await local.start().catch(() => {});
      return status();
    });

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

    if (externalUrl) void connectExternal().catch((error) => console.error('T3 existing server connection failed', error));
    else if (local) void local.start().catch((error) => console.error('T3 local server startup failed', error));
  },
});
