import { ORPCError, implement } from '@orpc/server';
import { neoContract, type T3Event } from '@neometaharness/contracts';
import type { SqliteDatabaseProvider } from '@neometaharness/db';
import type { NeoKernel } from '@neometaharness/kernel';
import { AgentService, HermesAgentRuntime } from '@neometaharness/agents';
import { coalesceText } from './coalesce.js';

/** The gateway owns the service lifetime. It follows Hermes enable/disable transitions. */
export async function createAgentGateway(db: SqliteDatabaseProvider, kernel: NeoKernel) {
  let service: AgentService | undefined;
  const hermesRunning = () => kernel.list().some((extension) =>
    extension.id === 'engine-hermes' && extension.status === 'running');
  const stop = async () => {
    const active = service;
    service = undefined;
    if (active) await active.dispose();
  };
  const sync = async () => {
    if (!hermesRunning()) { await stop(); return; }
    if (!service) {
      const active = new AgentService(db.agents, new HermesAgentRuntime(kernel));
      await active.start();
      service = active;
    }
  };
  const requireService = (): AgentService => {
    if (!hermesRunning() || !service) {
      throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'Agents require an enabled, healthy engine-hermes extension' });
    }
    return service;
  };
  await sync();
  const os = implement(neoContract);
  const router = {
    bots: {
      list: os.agents.bots.list.handler(() => requireService().records.listBots()),
      create: os.agents.bots.create.handler(({ input }) => requireService().createBot(input.name)),
      update: os.agents.bots.update.handler(async ({ input }) =>
        (await requireService().updateBot(input.id, input.name)) ?? null),
      delete: os.agents.bots.delete.handler(async ({ input }) => ({ deleted: await requireService().deleteBot(input.id) })),
    },
    turns: {
      send: os.agents.turns.send.handler(async ({ input }) => {
        const handle = await requireService().send(input.botId, input.text);
        void handle.done.catch(() => {});
        return { turnId: handle.turnId };
      }),
      list: os.agents.turns.list.handler(({ input }) => requireService().records.listTurns(input.botId)),
      stop: os.agents.turns.stop.handler(async ({ input }) => {
        const agents = requireService();
        await agents.stopTurn(input.turnId);
        return { stopped: (await agents.records.getTurn(input.turnId))?.status === 'stopped' };
      }),
      events: os.agents.turns.events.handler(async function* ({ input, signal }) {
        const agents = requireService();
        async function* raw(): AsyncGenerator<T3Event> {
          for await (const event of agents.events(input.turnId, input.since, signal)) {
            const payload = JSON.parse(event.payload) as Record<string, unknown>;
            if (event.kind === 'delta') {
              yield { kind: 'text.delta', sequence: event.seq, type: 'message.delta',
                messageId: input.turnId, textDelta: String(payload.text ?? '') };
            } else {
              yield { kind: 'event', sequence: event.seq, type: event.kind, payload };
            }
          }
        }
        yield* coalesceText(raw());
      }),
    },
    approvals: {
      list: os.agents.approvals.list.handler(({ input }) => requireService().records.approvalsForTurn(input.turnId)),
      resolve: os.agents.approvals.resolve.handler(async ({ input }) => ({
        resolved: await requireService().resolveApproval(input.id, input.decision),
      })),
    },
    rooms: {
      list: os.agents.rooms.list.handler(() => requireService().records.listRooms()),
      create: os.agents.rooms.create.handler(({ input }) => requireService().createRoom(input.name, input.memberIds)),
      post: os.agents.rooms.post.handler(async ({ input }) => {
        const handles = await requireService().sendRoomMessage(input.roomId, input.text, input.authorId);
        for (const handle of handles) void handle.done.catch(() => {});
        return { turnIds: handles.map((handle) => handle.turnId) };
      }),
      events: os.agents.rooms.events.handler(async function* ({ input, signal }) {
        yield* requireService().roomEvents(input.roomId, input.after, signal);
      }),
    },
    tasks: {
      list: os.agents.tasks.list.handler(({ input }) => requireService().records.listTasks(input.botId)),
      create: os.agents.tasks.create.handler(({ input }) => requireService().createTask(input.botId, input.title)),
      update: os.agents.tasks.update.handler(async ({ input }) => ({
        updated: await requireService().updateTask(input.id, input.status, input.note),
      })),
    },
    routines: {
      list: os.agents.routines.list.handler(() => requireService().records.listRoutines()),
      create: os.agents.routines.create.handler(({ input }) =>
        requireService().createRoutine(input.botId, input.name, input.prompt, input.schedule, input.timezone)),
      enable: os.agents.routines.enable.handler(async ({ input }) => {
        await requireService().setRoutineEnabled(input.id, input.enabled);
        return { enabled: input.enabled };
      }),
    },
  };
  return { router, sync, stop };
}
