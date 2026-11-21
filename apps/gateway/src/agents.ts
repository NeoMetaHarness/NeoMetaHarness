import { ORPCError, implement } from '@orpc/server';
import { neoContract, type T3Event } from '@neometaharness/contracts';
import type { SqliteDatabaseProvider } from '@neometaharness/db';
import type { NeoKernel } from '@neometaharness/kernel';
import { AgentService, HermesAgentRuntime } from '@neometaharness/agents';
import { coalesceText } from './coalesce.js';
import { requireViewer, requireMember, requireAdminOrOwner, type GatewayAuthContext } from './rbac.js';
import { authorize, destructiveToolApproval, policyMiddleware } from './policy.js';

/** The gateway owns the service lifetime. It follows Hermes enable/disable transitions. */
export async function createAgentGateway(db: SqliteDatabaseProvider, kernel: NeoKernel, mode: 'server' | 'desktop' = 'server') {
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
  const ownBot = async (botId: string, context: GatewayAuthContext): Promise<void> => {
    if (mode !== 'server') return;
    const bot = await db.agents.getBot(botId);
    if (!bot || !context.workspaceId || bot.workspace_id !== context.workspaceId) {
      throw new ORPCError('NOT_FOUND', { message: 'Bot not found' });
    }
  };
  const ownTurn = async (turnId: string, context: GatewayAuthContext): Promise<void> => {
    if (mode !== 'server') return;
    const turn = await db.agents.getTurn(turnId);
    if (!turn) throw new ORPCError('NOT_FOUND', { message: 'Turn not found' });
    await ownBot(turn.bot_id, context);
  };
  await sync();
  const os = implement(neoContract).$context<GatewayAuthContext>().use(policyMiddleware as any);
  const router = {
    bots: {
      list: os.agents.bots.list.handler(({ context }) => {
        authorize('agents.bots.list', context as GatewayAuthContext);
        return requireService().records.listBots().then((bots) =>
          mode === 'server' ? bots.filter((bot) => bot.workspace_id === context.workspaceId) : bots);
      }),
      create: os.agents.bots.create.handler(({ input, context }) => {
        authorize('agents.bots.create', context as GatewayAuthContext);
        return requireService().createBot(input.name, mode === 'server' ? context.workspaceId ?? undefined : undefined);
      }),
      update: os.agents.bots.update.handler(async ({ input, context }) => {
        authorize('agents.bots.update', context as GatewayAuthContext);
        await ownBot(input.id, context);
        return (await requireService().updateBot(input.id, input.name)) ?? null;
      }),
      delete: os.agents.bots.delete.handler(async ({ input, context }) => {
        authorize('agents.bots.delete', context as GatewayAuthContext);
        await ownBot(input.id, context);
        return { deleted: await requireService().deleteBot(input.id) };
      }),
    },
    turns: {
      send: os.agents.turns.send.handler(async ({ input, context }) => {
        authorize('agents.turns.send', context as GatewayAuthContext);
        await ownBot(input.botId, context);
        const handle = await requireService().send(input.botId, input.text);
        void handle.done.catch(() => {});
        return { turnId: handle.turnId };
      }),
      list: os.agents.turns.list.handler(async ({ input, context }) => {
        authorize('agents.turns.list', context as GatewayAuthContext);
        await ownBot(input.botId, context);
        return requireService().records.listTurns(input.botId);
      }),
      stop: os.agents.turns.stop.handler(async ({ input, context }) => {
        authorize('agents.turns.stop', context as GatewayAuthContext);
        await ownTurn(input.turnId, context);
        const agents = requireService();
        await agents.stopTurn(input.turnId);
        return { stopped: (await agents.records.getTurn(input.turnId))?.status === 'stopped' };
      }),
      events: os.agents.turns.events.handler(async function* ({ input, context, signal }) {
        authorize('agents.turns.events', context as GatewayAuthContext);
        await ownTurn(input.turnId, context);
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
      list: os.agents.approvals.list.handler(async ({ input, context }) => {
        authorize('agents.approvals.list', context as GatewayAuthContext);
        await ownTurn(input.turnId, context);
        return requireService().records.approvalsForTurn(input.turnId);
      }),
      resolve: os.agents.approvals.resolve.handler(async ({ input, context }) => {
        authorize('agents.approvals.resolve', context as GatewayAuthContext);
        if (mode === 'server') {
          const approval = await db.agents.getApproval(input.id);
          if (!approval) throw new ORPCError('NOT_FOUND', { message: 'Approval not found' });
          await ownTurn(approval.turn_id, context);
        }
        if (input.decision === 'allow') {
          const approval = await requireService().records.getApproval(input.id);
          if (approval && destructiveToolApproval(approval.tool, approval.detail)) {
            requireAdminOrOwner(context as GatewayAuthContext);
          }
        }
        return {
          resolved: await requireService().resolveApproval(input.id, input.decision),
        };
      }),
    },
    rooms: {
      list: os.agents.rooms.list.handler(({ context }) => {
        authorize('agents.rooms.list', context as GatewayAuthContext);
        return requireService().records.listRooms();
      }),
      create: os.agents.rooms.create.handler(({ input, context }) => {
        authorize('agents.rooms.create', context as GatewayAuthContext);
        return requireService().createRoom(input.name, input.memberIds);
      }),
      post: os.agents.rooms.post.handler(async ({ input, context }) => {
        authorize('agents.rooms.post', context as GatewayAuthContext);
        const handles = await requireService().sendRoomMessage(input.roomId, input.text, input.authorId);
        for (const handle of handles) void handle.done.catch(() => {});
        return { turnIds: handles.map((handle) => handle.turnId) };
      }),
      events: os.agents.rooms.events.handler(async function* ({ input, context, signal }) {
        authorize('agents.rooms.events', context as GatewayAuthContext);
        yield* requireService().roomEvents(input.roomId, input.after, signal);
      }),
    },
    tasks: {
      list: os.agents.tasks.list.handler(({ input, context }) => {
        authorize('agents.tasks.list', context as GatewayAuthContext);
        return requireService().records.listTasks(input.botId);
      }),
      create: os.agents.tasks.create.handler(({ input, context }) => {
        authorize('agents.tasks.create', context as GatewayAuthContext);
        return requireService().createTask(input.botId, input.title);
      }),
      update: os.agents.tasks.update.handler(async ({ input, context }) => {
        authorize('agents.tasks.update', context as GatewayAuthContext);
        return {
          updated: await requireService().updateTask(input.id, input.status, input.note),
        };
      }),
    },
    routines: {
      list: os.agents.routines.list.handler(({ context }) => {
        authorize('agents.routines.list', context as GatewayAuthContext);
        return requireService().records.listRoutines();
      }),
      create: os.agents.routines.create.handler(({ input, context }) => {
        authorize('agents.routines.create', context as GatewayAuthContext);
        return requireService().createRoutine(input.botId, input.name, input.prompt, input.schedule, input.timezone);
      }),
      enable: os.agents.routines.enable.handler(async ({ input, context }) => {
        authorize('agents.routines.enable', context as GatewayAuthContext);
        await requireService().setRoutineEnabled(input.id, input.enabled);
        return { enabled: input.enabled };
      }),
    },
  };
  return { router, sync, stop };
}
