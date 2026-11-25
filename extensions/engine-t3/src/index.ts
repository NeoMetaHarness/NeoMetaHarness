import { defineExtension } from '@neometaharness/kernel';
import { t3Origin, T3ControlPlane } from './client.js';
import { installedT3, T3Installer, type T3InstallStatus } from './install.js';
import { T3LocalRuntime } from './runtime.js';

interface T3Settings { existingServerUrl?: string; scopedSession?: string }

export default defineExtension({
  async activate(ctx) {
    const service = new T3ControlPlane();
    const enginesDir = ctx.inject<string>('enginesDir');
    // The repository or unpacked runtime the Gateway serves; it holds upstream.lock.json.
    const runtimeRoot = ctx.inject<string>('runtimeRoot');
    const settings = ctx.inject<T3Settings>('settings') ?? {};
    const externalUrl = process.env.NMH_T3_URL?.trim() || settings.existingServerUrl?.trim();
    // Treat legacy unbound secrets and a partially saved URL/secret pair as unconfigured.
    let externalSession = process.env.NMH_T3_URL?.trim() ? process.env.NMH_T3_SCOPED_SESSION?.trim() : undefined;
    if (!process.env.NMH_T3_URL?.trim() && settings.scopedSession) {
      try {
        const stored = JSON.parse(settings.scopedSession);
        if (stored?.url === externalUrl && typeof stored?.token === 'string') externalSession = stored.token;
      } catch { /* Ask for a scoped session bound to this origin. */ }
    }
    let validUrl = true;
    if (externalUrl) {
      try { t3Origin(externalUrl); } catch { validUrl = false; }
    }
    const abort = new AbortController();
    const executable = externalUrl ? undefined : installedT3(enginesDir, runtimeRoot);
    const testTtl = process.env.NODE_ENV === 'test' ? Number(process.env.NMH_TEST_T3_SESSION_TTL_MS) : 0;
    const local = executable && enginesDir ? new T3LocalRuntime(service, executable, enginesDir,
      Number.isSafeInteger(testTtl) && testTtl > 0 ? { sessionTtlMs: testTtl } : undefined) : undefined;
    let reason = !validUrl ? 'Use an HTTPS URL for the existing T3 server. HTTP is allowed on loopback.'
      : externalUrl && !externalSession ? 'An existing T3 server needs a scoped session in Settings.' : '';
    let connecting: Promise<void> | undefined;
    const connectExternal = () => {
      if (abort.signal.aborted || !validUrl || !externalUrl || !externalSession || service.connected) return Promise.resolve();
      if (!connecting) {
        reason = 'Connecting to the existing T3 server…';
        connecting = service.connect(externalUrl, externalSession, abort.signal, () => {
          reason = 'The existing T3 server disconnected. Choose Reconnect to try again.';
        }).then(() => { reason = ''; })
          .catch((error: unknown) => {
            if (abort.signal.aborted) return;
            console.error('T3 existing server connection failed', error);
            reason = "Couldn't connect to the existing T3 server. Check its URL and scoped session in Settings, then retry.";
            throw error;
          }).finally(() => { connecting = undefined; });
      }
      return connecting;
    };
    const installer = new T3Installer(enginesDir, () => {
      void ctx.reactivate().catch((error) => console.error('T3 restart after install failed', error));
    }, runtimeRoot);
    const status = (): T3InstallStatus => {
      if (externalUrl) return { state: 'ready', message: reason || 'Connected to the existing T3 server.',
        connected: service.connected, external: true, ...(connecting ? { phase: 'starting' as const } : {}) };
      if (executable) return { state: 'ready', message: local?.reason || 'T3 is ready.', connected: service.connected, ...(local?.pending ? { phase: 'starting' as const } : {}) };
      return installer.current();
    };

    ctx.provide('codingControlPlane', service);
    ctx.effect(() => async () => {
      abort.abort();
      await Promise.all([installer.cancel(), local ? local.stop() : service.disconnect(), connecting?.catch(() => {})]);
    });
    ctx.health(() => {
      const current = status();
      return { ok: service.connected, ...(local?.pid ? { pid: local.pid } : {}),
        ...(service.connected ? {} : { reason: current.error ?? current.message }) };
    });

    ctx.route('install/status', () => status());
    ctx.route('install/start', () => externalUrl || executable ? status() : installer.start());
    ctx.route('runtime/start', () => {
      if (externalUrl) void connectExternal().catch(() => {});
      else if (local) void local.start().catch(() => {});
      return status();
    });

    // Activation does not wait for T3. A request waits for a connect in flight, or says why T3 is unavailable.
    const ready = async () => {
      if (service.connected) return;
      const pending = externalUrl ? connecting : local?.connecting;
      if (pending) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([pending.catch(() => {}), new Promise((done) => { timer = setTimeout(done, 20_000); })]);
        clearTimeout(timer);
      }
      if (service.connected) return;
      const current = status();
      const why = current.error ?? (current.state === 'ready' && current.message === 'T3 is ready.'
        ? 'the connection closed. Choose Start in Extensions to reconnect.' : current.message);
      throw Object.assign(new Error('T3 is not connected: ' + why), { code: 'T3_NOT_CONNECTED' });
    };
    const connected = <T>(handler: (body: unknown) => T) => async ({ body }: { body?: unknown }) => {
      await ready();
      return handler(body);
    };

    ctx.route('create', connected((body) => service.createThread(body as Parameters<typeof service.createThread>[0])));
    ctx.route('send', connected((body) => service.sendMessage(body as Parameters<typeof service.sendMessage>[0])));
    ctx.route('events', connected((body) => {
      const input = body as { threadId: string; signal?: AbortSignal };
      return service.subscribeThread(input.threadId, input.signal);
    }));
    ctx.route('approval', connected((body) => service.respond(body as Parameters<typeof service.respond>[0])));
    ctx.route('settle', connected((body) => service.settle((body as { threadId: string }).threadId)));
    ctx.route('stop', connected((body) => service.stop(body as Parameters<typeof service.stop>[0])));
    ctx.route('diff', connected((body) => service.diff(body as Parameters<typeof service.diff>[0])));
    ctx.route('rollback', connected((body) => service.rollback(body as Parameters<typeof service.rollback>[0])));
    ctx.route('providers/list', connected(() => service.listProviders()));
    ctx.route('subscription/status', connected(() => service.subscription.status(!externalUrl)));
    ctx.route('subscription/start', connected((body) => {
      if (externalUrl) throw new Error('ChatGPT sign-in requires the isolated local T3 server.');
      return service.subscription.start((body as { instanceId: string }).instanceId);
    }));
    ctx.route('subscription/poll', connected((body) => {
      if (externalUrl) throw new Error('ChatGPT sign-in requires the isolated local T3 server.');
      return service.subscription.poll((body as { instanceId: string }).instanceId);
    }));
    ctx.route('subscription/cancel', connected((body) => {
      if (externalUrl) throw new Error('ChatGPT sign-in requires the isolated local T3 server.');
      const { instanceId, flowId } = body as { instanceId: string; flowId: string };
      return service.subscription.cancel(instanceId, flowId);
    }));
    ctx.route('threads/list', connected(() => service.listThreads()));

    if (externalUrl) void connectExternal().catch(() => {});
    else if (local && enginesDir && T3LocalRuntime.serving(enginesDir)) {
      // A staged upgrade reuses the server the serving generation runs. Connect before the
      // kernel's one health check, but never hold activation past its deadline.
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([local.start().catch(() => {}), new Promise((done) => { timer = setTimeout(done, 4000); })]);
      clearTimeout(timer);
    } else if (local) void local.start().catch(() => {});
  },
});
