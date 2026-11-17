import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RPCHandler as WSRPCHandler } from '@orpc/server/ws';
import { RPCHandler as HttpRPCHandler } from '@orpc/server/node';
import { implement, ORPCError } from '@orpc/server';
import { neoContract, type T3Event } from '@neometaharness/contracts';
import { SqliteDatabaseProvider } from '@neometaharness/db';
import { NeoKernel } from '@neometaharness/kernel';
import { coalesceText } from './coalesce.js';

export interface GatewayOptions {
  databaseFile: string;
  extensionsDir?: string;
  port?: number;
}

const defaultExtensions = fileURLToPath(new URL('../../../extensions/', import.meta.url));

export async function startGateway(options: GatewayOptions) {
  const db = new SqliteDatabaseProvider(options.databaseFile);
  const kernel = new NeoKernel(db);
  try {
    await kernel.discover(resolve(options.extensionsDir ?? defaultExtensions));
  } catch (error) {
    await kernel.close();
    throw error;
  }

  const os = implement(neoContract);
  const invokeT3 = async (route: string, body: unknown) => {
    const path = `/x/engine-t3/${route}`;
    if (!kernel.hasRoute(path)) throw new ORPCError('NOT_FOUND', { message: 'T3 extension is disabled' });
    return kernel.invokeRoute(path, 'RPC', body);
  };
  const withHealth = async (id: string) => {
    const health = await kernel.health(id).catch(() => ({ ok: false }));
    return { ...kernel.status(id), ...(health ? { health } : {}) };
  };
  const router = {
    x: { 'engine-t3': {
      create: os.x['engine-t3'].create.handler(async ({ input }) => invokeT3('create', input) as Promise<{ sequence: number }>),
      send: os.x['engine-t3'].send.handler(async ({ input }) => invokeT3('send', input) as Promise<{ sequence: number }>),
      events: os.x['engine-t3'].events.handler(async function* ({ input, signal }) {
        const stream = await invokeT3('events', { ...input, signal }) as AsyncIterable<T3Event>;
        yield* coalesceText(stream);
      }),
      approval: os.x['engine-t3'].approval.handler(async ({ input }) => invokeT3('approval', input) as Promise<{ sequence: number }>),
      settle: os.x['engine-t3'].settle.handler(async ({ input }) => invokeT3('settle', input) as Promise<{ sequence: number }>),
    } },
    extensions: {
      list: os.extensions.list.handler(async () => Promise.all(kernel.list().map((extension) => withHealth(extension.id)))),
      enable: os.extensions.enable.handler(async ({ input }) => { await kernel.enable(input.id); return withHealth(input.id); }),
      disable: os.extensions.disable.handler(async ({ input }) => { await kernel.disable(input.id); return withHealth(input.id); }),
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
      if (origin && /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)) {
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
      if (path.startsWith('/x/engine-t3/')) {
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
  return {
    port: address.port,
    kernel,
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((done) => wss.close(() => done()));
      await new Promise<void>((done) => http.close(() => done()));
      await kernel.close();
    },
  };
}
