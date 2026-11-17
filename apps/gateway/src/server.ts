import { createServer } from 'node:http';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RPCHandler as WSRPCHandler } from '@orpc/server/ws';
import { RPCHandler as HttpRPCHandler } from '@orpc/server/node';
import { implement, ORPCError } from '@orpc/server';
import { computerActionSchema, neoContract, type T3Event, type HermesEvent, type DshEvent, type VaultOperation } from '@neometaharness/contracts';
import { VaultService, KeyFileProvider, type KeyProvider, type VaultScope } from '@neometaharness/vault';
import { SqliteDatabaseProvider } from '@neometaharness/db';
import { NeoKernel } from '@neometaharness/kernel';
import { ComputerRegistry } from '@neometaharness/computers';
import { coalesceText } from './coalesce.js';
import { createAgentGateway } from './agents.js';

export interface GatewayOptions {
  databaseFile: string;
  extensionsDir?: string;
  port?: number;
  vaultKeyFile?: string;
  vaultKeyProvider?: KeyProvider;
  authorizeVault?: (operation: VaultOperation, scope: VaultScope) => boolean | Promise<boolean>;
}

const defaultExtensions = fileURLToPath(new URL('../../../extensions/', import.meta.url));

export async function startGateway(options: GatewayOptions) {
  const db = new SqliteDatabaseProvider(options.databaseFile);
  const vault = new VaultService(db, options.vaultKeyProvider ?? new KeyFileProvider(
    options.vaultKeyFile ?? join(dirname(resolve(options.databaseFile)), 'vault-keys', 'master.key'),
  ));
  let gatewayPort = 0;
  const computers = new ComputerRegistry(
    () => {
      if (!gatewayPort) throw new Error('Computer Gateway is not listening');
      return `http://127.0.0.1:${gatewayPort}/internal/computers/action`;
    },
    (notice) => kernel.events.publishComputer(notice),
  );
  const kernel = new NeoKernel(db, {
    computers,
    vault,
    extensionDataDir: join(dirname(resolve(options.databaseFile)), 'extensions'),
  });
  const authorizeVault = async (operation: VaultOperation, scope: VaultScope) => {
    if (await options.authorizeVault?.(operation, scope) !== true) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Vault access denied' });
    }
  };
  try {
    await kernel.discover(resolve(options.extensionsDir ?? defaultExtensions));
  } catch (error) {
    await kernel.close();
    throw error;
  }

  const agentApi = await createAgentGateway(db, kernel);
  const os = implement(neoContract);
  const invokeT3 = async (route: string, body: unknown) => {
    const path = `/x/engine-t3/${route}`;
    if (!kernel.hasRoute(path)) throw new ORPCError('NOT_FOUND', { message: 'T3 extension is disabled' });
    return kernel.invokeRoute(path, 'RPC', body);
  };
  const invokeHermes = async (route: string, body: unknown) => {
    const path = `/x/engine-hermes/${route}`;
    if (!kernel.hasRoute(path)) throw new ORPCError('NOT_FOUND', { message: 'Hermes extension is disabled' });
    return kernel.invokeRoute(path, 'RPC', body);
  };
  const invokeDsh = async (route: string, body: unknown) => {
    const path = `/x/engine-dsh/${route}`;
    if (!kernel.hasRoute(path)) throw new ORPCError('NOT_FOUND', { message: 'DSH extension is disabled' });
    return kernel.invokeRoute(path, 'RPC', body);
  };
  const withHealth = async (id: string) => {
    const health = await kernel.health(id).catch(() => ({ ok: false }));
    return { ...kernel.status(id), ...(health ? { health } : {}) };
  };
  const router = {
    agents: agentApi.router,
    x: { 'engine-dsh': {
      create: os.x['engine-dsh'].create.handler(async ({ input }) => invokeDsh('create', input) as Promise<{ sessionId: string; pid: number }>),
      prompt: os.x['engine-dsh'].prompt.handler(async ({ input }) => invokeDsh('prompt', input) as Promise<{ messageId: string }>),
      events: os.x['engine-dsh'].events.handler(async function* ({ input, signal }) {
        const stream = await invokeDsh('events', { ...input, signal }) as AsyncIterable<DshEvent>;
        yield* coalesceText(stream);
      }),
      wait: os.x['engine-dsh'].wait.handler(async ({ input }) => invokeDsh('wait', input) as Promise<{ status: 'settled' }>),
      cancel: os.x['engine-dsh'].cancel.handler(async ({ input }) => invokeDsh('cancel', input) as Promise<{ cancelled: boolean }>),
      shutdown: os.x['engine-dsh'].shutdown.handler(async ({ input }) => invokeDsh('shutdown', input) as Promise<{ stopped: boolean }>),
    }, 'engine-t3': {
      create: os.x['engine-t3'].create.handler(async ({ input }) => invokeT3('create', input) as Promise<{ sequence: number }>),
      send: os.x['engine-t3'].send.handler(async ({ input }) => invokeT3('send', input) as Promise<{ sequence: number }>),
      events: os.x['engine-t3'].events.handler(async function* ({ input, signal }) {
        const stream = await invokeT3('events', { ...input, signal }) as AsyncIterable<T3Event>;
        yield* coalesceText(stream);
      }),
      approval: os.x['engine-t3'].approval.handler(async ({ input }) => invokeT3('approval', input) as Promise<{ sequence: number }>),
      settle: os.x['engine-t3'].settle.handler(async ({ input }) => invokeT3('settle', input) as Promise<{ sequence: number }>),
    }, 'engine-hermes': {
      profiles: {
        list: os.x['engine-hermes'].profiles.list.handler(async () => invokeHermes('profiles/list', {}) as Promise<{ profiles: { name: string; path: string }[] }>),
        create: os.x['engine-hermes'].profiles.create.handler(async ({ input }) => invokeHermes('profiles/create', input) as Promise<{ ok: boolean; name: string; path: string }>),
        delete: os.x['engine-hermes'].profiles.delete.handler(async ({ input }) => invokeHermes('profiles/delete', input)),
      },
      runs: {
        start: os.x['engine-hermes'].runs.start.handler(async ({ input }) => invokeHermes('runs/start', input) as Promise<{ run_id: string }>),
        events: os.x['engine-hermes'].runs.events.handler(async function* ({ input, signal }) {
          const stream = await invokeHermes('runs/events', { ...input, signal }) as AsyncIterable<HermesEvent>;
          yield* coalesceText(stream);
        }),
        approve: os.x['engine-hermes'].runs.approve.handler(async ({ input }) => invokeHermes('runs/approve', input) as Promise<{ ok: boolean }>),
        stop: os.x['engine-hermes'].runs.stop.handler(async ({ input }) => invokeHermes('runs/stop', input) as Promise<{ status: string }>),
      },
      cron: {
        list: os.x['engine-hermes'].cron.list.handler(async () => invokeHermes('cron/list', {}) as Promise<Record<string, unknown>[]>),
        create: os.x['engine-hermes'].cron.create.handler(async ({ input }) => invokeHermes('cron/create', input) as Promise<{ id: string }>),
        delete: os.x['engine-hermes'].cron.delete.handler(async ({ input }) => invokeHermes('cron/delete', input)),
      },
    } },
    extensions: {
      list: os.extensions.list.handler(async () => Promise.all(kernel.list().map((extension) => withHealth(extension.id)))),
      enable: os.extensions.enable.handler(async ({ input }) => { await kernel.enable(input.id); if (input.id === 'engine-hermes') await agentApi.sync(); return withHealth(input.id); }),
      disable: os.extensions.disable.handler(async ({ input }) => { if (input.id === 'engine-hermes') await agentApi.stop(); await kernel.disable(input.id); return withHealth(input.id); }),
    },
    vault: {
      list: os.vault.list.handler(async ({ input }) => {
        await authorizeVault('list', input.scope);
        return vault.list(input.scope);
      }),
      put: os.vault.put.handler(async ({ input }) => {
        await authorizeVault('put', input.scope);
        return vault.put(input.scope, input.name, input.value);
      }),
      rotate: os.vault.rotate.handler(async ({ input }) => {
        await authorizeVault('rotate', input.scope);
        return vault.rotate(input.scope, input.name, input.value);
      }),
      delete: os.vault.delete.handler(async ({ input }) => {
        await authorizeVault('delete', input.scope);
        return { deleted: await vault.delete(input.scope, input.name) };
      }),
    },
    computers: {
      list: os.computers.list.handler(async () => computers.list()),
      attach: os.computers.attach.handler(async ({ input }) => computers.attach(input.providerId, input.target)),
      release: os.computers.release.handler(async ({ input }) => ({ released: await computers.release(input.id) })),
      lease: os.computers.lease.handler(async ({ input }) => computers.lease(input.id, input.holder)),
      assign: os.computers.assign.handler(async ({ input }) => {
        computers.assign(input.engine, input.targetId, input.computerId);
        return input;
      }),
      kill: os.computers.kill.handler(async ({ input }) => computers.kill(input.engaged)),
    },
    events: {
      subscribe: os.events.subscribe.handler(async function* ({ input, signal }) {
        yield* kernel.events.subscribe(input.since, signal);
      }),
    },
  };
  const httpRPC = new HttpRPCHandler(router);
  const wsRPC = new WSRPCHandler(router);
  const http = createServer(async (req, res) => {
    try {
      const origin = req.headers.origin;
      // The web/PWA shell runs on a separate localhost port during development.
      if (origin && /^(?:https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?|https?:\/\/tauri\.localhost|tauri:\/\/localhost)$/.test(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ?? 'content-type');
        if (req.headers['access-control-request-private-network'] === 'true') {
          res.setHeader('Access-Control-Allow-Private-Network', 'true');
        }
      }
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (path === '/internal/computers/action') {
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        const match = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '');
        if (!match) { res.writeHead(401).end(); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > 16_384) { res.writeHead(413).end(); return; }
          chunks.push(chunk as Buffer);
        }
        let payload: unknown;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400).end();
          return;
        }
        const parsed = computerActionSchema.safeParse(payload);
        if (!parsed.success) { res.writeHead(400).end(); return; }
        try {
          const result = await computers.act(match[1]!, parsed.data);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(403, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: (error as Error).message }));
        }
        return;
      }
      if (path.startsWith('/x/engine-t3/') || path.startsWith('/x/engine-hermes/') || path.startsWith('/x/engine-dsh/')) {
        if (!kernel.hasRoute(path)) { res.writeHead(404).end(); return; }
        const matched = await httpRPC.handle(req, res);
        if (!matched.matched) res.writeHead(404).end();
        return;
      }
      if (kernel.hasRoute(path)) {
        if (req.method !== 'GET') {
          res.writeHead(405).end();
          return;
        }
        const result = await kernel.invokeRoute(path, 'GET');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(result));
        return;
      }
      if (path.startsWith('/x/')) {
        res.writeHead(404).end();
        return;
      }
      const matched = await httpRPC.handle(req, res);
      if (!matched.matched) res.writeHead(404).end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: (error as Error).message }));
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req); });
  });
  wss.on('connection', (ws) => { void wsRPC.upgrade(ws); });
  try {
    await new Promise<void>((resolveListen, reject) => {
      http.once('error', reject);
      http.listen(options.port ?? 0, '127.0.0.1', resolveListen);
    });
  } catch (error) {
    await kernel.close();
    throw error;
  }
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected gateway address');
  gatewayPort = address.port;
  return {
    port: address.port,
    kernel,
    vault,
    computers,
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((done) => wss.close(() => done()));
      await new Promise<void>((done) => http.close(() => done()));
      await agentApi.stop();
      await kernel.close();
    },
  };
}
