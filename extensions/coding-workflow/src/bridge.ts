import { createServer, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionContext } from '@neometaharness/kernel';
import { restrictPrivatePath } from '@neometaharness/vault';

type DshRuntime = {
  create(input: { workspaceId: string; cwd: string }): Promise<{ sessionId: string }>;
  prompt(input: { sessionId: string; text: string }): Promise<unknown>;
  events(input: { sessionId: string; signal?: AbortSignal; afterSequence?: number }): AsyncIterable<{ sequence?: number; kind: string; textDelta?: string; type?: string }>;
  wait(input: { sessionId: string }): Promise<unknown>;
  cancel(input: { sessionId: string }): Promise<unknown>;
  shutdown(input: { sessionId: string }): Promise<unknown>;
};

export async function createAcpBridge(ctx: ExtensionContext, dataDir: string,
  allowCwd: (cwd: string) => Promise<void>) {
  const token = randomBytes(32).toString('hex');
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\neo-coding-${token.slice(0, 24)}` : join(dataDir, 'acp.sock');
  const tokenFile = join(dataDir, 'acp.token');
  await mkdir(dataDir, { recursive: true });
  await restrictPrivatePath(dataDir);
  await writeFile(tokenFile, token, { mode: 0o600 });
  await restrictPrivatePath(tokenFile);
  const sockets = new Set<Socket>();
  const sessions = new Map<string, DshRuntime>();
  let workspaceId = 'default';
  const runtime = () => {
    const service = ctx.inject<DshRuntime>('dshAgentRuntime');
    if (!service) throw new Error('DSH extension is disabled');
    return service;
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    const owned = new Set<string>();
    const cursors = new Map<string, number>();
    let accepted = false;
    const write = (message: unknown) => { if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n'); };
    const cleanup = () => {
      sockets.delete(socket);
      for (const id of owned) {
        void sessions.get(id)?.shutdown({ sessionId: id }).catch(() => {});
        sessions.delete(id);
      }
    };
    socket.on('close', cleanup);
    socket.on('error', () => socket.destroy());
    // ACP cancellation must remain concurrent with session/prompt.
    const lines = createInterface({ input: socket });
    lines.on('line', (line) => { void (async () => {
      let message: any;
      try {
        const packet = JSON.parse(line);
        const given = Buffer.from(String(packet.token));
        if (given.length !== token.length || !timingSafeEqual(given, Buffer.from(token))) return socket.destroy();
        accepted = true;
        message = packet.message;
        const { id, method, params = {} } = message;
        const respond = (result: unknown) => { if (id !== undefined) write({ jsonrpc: '2.0', id, result }); };
        if (method === 'initialize') return respond({ protocolVersion: 2,
          info: { name: 'neo-coding', version: '0.1.0' }, capabilities: { session: {} } });
        if (method === 'session/new') {
          await allowCwd(params.cwd);
          const engine = runtime();
          const session = await engine.create({ workspaceId, cwd: params.cwd });
          if (socket.destroyed) { await engine.shutdown(session); return; }
          owned.add(session.sessionId); sessions.set(session.sessionId, engine);
          return respond({ sessionId: session.sessionId, configOptions: [] });
        }
        const sessionId = String(params.sessionId);
        if (!owned.has(sessionId)) throw new Error('Unknown ACP session');
        const engine = runtime();
        if (engine !== sessions.get(sessionId)) throw new Error('DSH session was disabled');
        if (method === 'session/cancel') { await engine.cancel({ sessionId }); return respond({}); }
        if (method === 'session/prompt') {
          if ((params.prompt ?? []).some((block: any) => block.type !== 'text')) {
            throw new Error('Neo coding currently accepts text prompts only');
          }
          const abort = new AbortController();
          const onClose = () => abort.abort();
          socket.once('close', onClose);
          const pump = (async () => {
            for await (const event of engine.events({ sessionId, signal: abort.signal, afterSequence: cursors.get(sessionId) ?? 0 })) {
              if (event.sequence) cursors.set(sessionId, event.sequence);
              if (event.kind === 'text.delta') write({ jsonrpc: '2.0', method: 'session/update', params: {
                sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.textDelta ?? '' } },
              } });
              if (event.type === 'session.settled') return;
            }
          })();
          try {
            await engine.prompt({ sessionId, text: (params.prompt ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') });
            await engine.wait({ sessionId });
            await pump;
            write({ jsonrpc: '2.0', method: 'session/update', params: {
              sessionId, update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' },
            } });
            return respond({});
          } finally { abort.abort(); socket.off('close', onClose); }
        }
        if (id !== undefined) write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported ACP method' } });
      } catch (error) {
        if (accepted && message?.id !== undefined) write({ jsonrpc: '2.0', id: message.id,
          error: { code: -32000, message: error instanceof Error ? error.message : 'ACP request failed' } });
      }
    })(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  const stopSessions = async () => {
      const current = [...sessions];
      for (const socket of sockets) socket.destroy();
      await Promise.all(current.map(([sessionId, engine]) => engine.shutdown({ sessionId }).catch(() => {})));
      sessions.clear();
  };
  return { endpoint, tokenFile, stopSessions, setWorkspace(id: string) { workspaceId = id; },
    async close() {
      await stopSessions();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(tokenFile, { force: true });
    },
  };
}
