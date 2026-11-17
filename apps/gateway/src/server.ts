import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RPCHandler as WSRPCHandler } from '@orpc/server/ws';
import { RPCHandler as HttpRPCHandler } from '@orpc/server/node';
import { implement } from '@orpc/server';
import { neoContract } from '@neometaharness/contracts';
import { SqliteDatabaseProvider } from '@neometaharness/db';
import { NeoKernel } from '@neometaharness/kernel';

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
  const withHealth = async (id: string) => {
    const health = await kernel.health(id).catch(() => ({ ok: false }));
    return { ...kernel.status(id), ...(health ? { health } : {}) };
  };
  const router = {
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
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
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
