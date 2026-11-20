import { randomUUID } from 'node:crypto';
import type {
  AgentApproval, AgentBot, AgentRecords, AgentRoom, AgentTask, AgentRoutine, AgentTurn,
} from '@neometaharness/db';
import type { AgentRuntime, AgentRuntimeEvent } from './runtime.js';

export interface TurnHandle { turnId: string; done: Promise<void> }
type Decision = 'allow' | 'deny' | 'stop';

/** Stateful domain service, independent of channels, models, UI and engine transport. */
export class AgentService {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly active = new Map<string, { runId: string; controller: AbortController }>();
  private readonly approvals = new Map<string, (decision: Decision) => void>();
  private readonly cronIds = new Set<string>();
  private readonly turnListeners = new Set<(turnId: string) => void>();
  private readonly roomListeners = new Set<(roomId: string) => void>();

  constructor(readonly records: AgentRecords, readonly runtime: AgentRuntime) {}

  async start(): Promise<void> {
    await this.records.interruptUnfinished();
    for (const routine of await this.records.listRoutines()) {
      if (routine.enabled) await this.registerCron(routine);
    }
  }

  async dispose(): Promise<void> {
    for (const id of this.cronIds) await this.runtime.cron.unregister(id);
    this.cronIds.clear();
    for (const turnId of [...this.active.keys()]) await this.stopTurn(turnId);
    await Promise.allSettled([...this.queues.values()]);
  }

  async createBot(name: string, workspaceId?: string): Promise<AgentBot> {
    if (!name.trim()) throw new Error('Bot name required');
    const bot = { id: randomUUID(), name: name.trim(), created_at: Date.now(), workspace_id: workspaceId ?? null };
    await this.records.createBot(bot);
    return bot;
  }

  async updateBot(id: string, name: string): Promise<AgentBot | undefined> {
    if (!name.trim()) throw new Error('Bot name required');
    return this.records.updateBot(id, name.trim());
  }

  async deleteBot(id: string): Promise<boolean> {
    if (!await this.records.getBot(id)) return false;
    for (const turn of await this.records.listTurns(id)) await this.stopTurn(turn.id);
    await this.queues.get(id);
    for (const routine of await this.records.listRoutines()) {
      if (routine.bot_id === id && this.cronIds.has(routine.id)) {
        await this.runtime.cron.unregister(routine.id);
        this.cronIds.delete(routine.id);
      }
    }
    return this.records.deleteBot(id);
  }

  private async appendEvent(turnId: string, kind: string, payload: unknown): Promise<void> {
    await this.records.appendEvent(turnId, kind, JSON.stringify(payload));
    for (const listener of this.turnListeners) listener(turnId);
  }

  private async finishTurn(turnId: string, status: AgentTurn['status']): Promise<void> {
    if (await this.records.finishTurn(turnId, status)) {
      for (const listener of this.turnListeners) listener(turnId);
    }
  }

  async *events(turnId: string, since = 0, signal?: AbortSignal): AsyncGenerator<{ seq: number; kind: string; payload: string }> {
    if (!await this.records.getTurn(turnId)) throw new Error('Unknown turn ' + turnId);
    let wake: (() => void) | undefined;
    let changed = false;
    const notify = (id: string) => { if (id === turnId) { changed = true; wake?.(); } };
    const abort = () => { changed = true; wake?.(); };
    this.turnListeners.add(notify);
    signal?.addEventListener('abort', abort);
    let cursor = since;
    try {
      while (!signal?.aborted) {
        changed = false;
        // Check status before the event query, so a terminal transaction's
        // final event cannot land between a read and the exit decision.
        const turn = await this.records.getTurn(turnId);
        for (const event of await this.records.turnEventsSince(turnId, cursor)) {
          cursor = event.seq;
          yield event;
        }
        if (!turn || !['queued', 'running', 'awaiting_approval'].includes(turn.status)) return;
        if (changed || signal?.aborted) continue;
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
    } finally {
      this.turnListeners.delete(notify);
      signal?.removeEventListener('abort', abort);
    }
  }

  async *roomEvents(roomId: string, after?: string, signal?: AbortSignal): AsyncGenerator<import('@neometaharness/db').AgentRoomMessage> {
    if (!await this.records.getRoom(roomId)) throw new Error('Unknown room ' + roomId);
    let wake: (() => void) | undefined;
    let changed = false;
    const notify = (id: string) => { if (id === roomId) { changed = true; wake?.(); } };
    const abort = () => { changed = true; wake?.(); };
    this.roomListeners.add(notify);
    signal?.addEventListener('abort', abort);
    let cursor = after;
    try {
      while (!signal?.aborted) {
        changed = false;
        const messages = await this.records.roomMessages(roomId);
        const index = cursor ? messages.findIndex((msg) => msg.id === cursor) : -1;
        for (const message of messages.slice(index + 1)) {
          cursor = message.id;
          yield message;
        }
        if (changed || signal?.aborted) continue;
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
    } finally {
      this.roomListeners.delete(notify);
      signal?.removeEventListener('abort', abort);
    }
  }

  async createRoom(name: string, memberIds: string[]): Promise<AgentRoom> {
    const uniqueIds = [...new Set(memberIds)];
    for (const id of uniqueIds) {
      if (!(await this.records.getBot(id))) throw new Error(`Unknown bot ${id}`);
    }
    const room = { id: randomUUID(), name, created_at: Date.now() };
    await this.records.createRoom(room, uniqueIds);
    return room;
  }

  async send(botId: string, input: string, source: AgentTurn['source'] = 'user', roomId: string | null = null): Promise<TurnHandle> {
    if (!(await this.records.getBot(botId))) throw new Error(`Unknown bot ${botId}`);
    const now = Date.now();
    const turn: AgentTurn = {
      id: randomUUID(), bot_id: botId, input, room_id: roomId, source,
      status: 'queued', created_at: now, updated_at: now,
    };
    await this.records.createTurn(turn);
    const previous = this.queues.get(botId) ?? Promise.resolve();
    const done = previous.then(() => this.runTurn(turn));
    const settled = done.then(() => {}, () => {});
    this.queues.set(botId, settled);
    void settled.then(() => { if (this.queues.get(botId) === settled) this.queues.delete(botId); });
    return { turnId: turn.id, done };
  }

  async sendToBot(fromBotId: string, toBotId: string, text: string): Promise<TurnHandle> {
    const sender = await this.records.getBot(fromBotId);
    if (!sender) throw new Error(`Unknown bot ${fromBotId}`);
    return this.send(toBotId, `[Message from ${sender.name}]\n${text}`, 'bot');
  }

  async sendRoomMessage(roomId: string, text: string, authorId = 'user'): Promise<TurnHandle[]> {
    const room = await this.records.getRoom(roomId);
    if (!room) throw new Error(`Unknown room ${roomId}`);
    await this.records.createRoomMessage({ id: randomUUID(), room_id: roomId, author_id: authorId, body: text, created_at: Date.now() });
    for (const notify of this.roomListeners) notify(roomId);
    const members = await this.records.roomMembers(roomId);
    return Promise.all(members.map((bot) => this.send(bot.id, `[Room ${room.name}] ${text}`, 'room', roomId)));
  }

  async postToRoom(roomId: string, botId: string, text: string): Promise<void> {
    const members = await this.records.roomMembers(roomId);
    if (!members.some((member) => member.id === botId)) throw new Error('Bot is not a room member');
    await this.records.createRoomMessage({ id: randomUUID(), room_id: roomId, author_id: botId, body: text, created_at: Date.now() });
    for (const notify of this.roomListeners) notify(roomId);
  }

  private async runTurn(turn: AgentTurn): Promise<void> {
    if ((await this.records.getTurn(turn.id))?.status === 'stopped') return;
    await this.records.setTurnStatus(turn.id, 'running');
    const controller = new AbortController();
    let completed = false;
    let finalStatus: AgentTurn['status'] = 'completed';
    try {
      const { runId } = await this.runtime.startRun({
        turnId: turn.id, botId: turn.bot_id, input: turn.input, source: turn.source,
        ...(turn.room_id ? { roomId: turn.room_id } : {}),
      });
      this.active.set(turn.id, { runId, controller });
      if ((await this.records.getTurn(turn.id))?.status === 'stopped') {
        await this.runtime.stop(runId);
        return;
      }
      for await (const event of this.runtime.streamEvents(runId, controller.signal)) {
        await this.appendEvent(turn.id, event.type, event);
        if (event.type === 'approval_requested') {
          const decision = await this.waitForApproval(turn.id, event);
          if (decision === 'stop') { finalStatus = 'stopped'; break; }
          await this.runtime.approve(runId, event.requestId, decision);
          if (decision === 'deny') {
            await this.runtime.stop(runId);
            finalStatus = 'denied';
            break;
          }
          if (!(await this.records.resumeApprovedTurn(turn.id))) {
            finalStatus = 'stopped';
            break;
          }
        } else if (event.type === 'completed') {
          completed = true;
          break;
        } else if (event.type === 'failed') {
          throw new Error(event.reason);
        }
      }
      if (!completed && finalStatus === 'completed') finalStatus = 'interrupted';
      await this.finishTurn(turn.id, finalStatus);
    } catch (error) {
      await this.finishTurn(turn.id, 'failed');
      throw error;
    } finally {
      await this.records.interruptApprovals(turn.id);
      this.active.delete(turn.id);
    }
  }

  private async waitForApproval(turnId: string, event: Extract<AgentRuntimeEvent, { type: 'approval_requested' }>): Promise<Decision> {
    const approval: AgentApproval = {
      id: randomUUID(), turn_id: turnId, request_id: event.requestId, tool: event.tool,
      detail: event.detail, status: 'pending', created_at: Date.now(), resolved_at: null,
    };
    await this.records.createApproval(approval);
    if (!(await this.records.setAwaitingApproval(turnId))) {
      await this.records.interruptApprovals(turnId);
      return 'stop';
    }
    const decision = await new Promise<Decision>((resolve) => {
      this.approvals.set(approval.id, resolve);
      // A stop could have landed after the DB write, before this waiter existed.
      if (this.active.get(turnId)?.controller.signal.aborted) resolve('stop');
    });
    this.approvals.delete(approval.id);
    await this.appendEvent(turnId, 'approval_resolved', { approvalId: approval.id, decision });
    return decision;
  }

  async resolveApproval(id: string, decision: 'allow' | 'deny'): Promise<boolean> {
    const waiter = this.approvals.get(id);
    if (!waiter) return false;
    const changed = await this.records.resolveApproval(id, decision === 'allow' ? 'approved' : 'denied');
    if (changed) waiter(decision);
    return changed;
  }

  async stopTurn(turnId: string): Promise<void> {
    const turn = await this.records.getTurn(turnId);
    if (!turn || !['queued', 'running', 'awaiting_approval'].includes(turn.status)) return;
    await this.finishTurn(turnId, 'stopped');
    await this.records.interruptApprovals(turnId);
    for (const approval of await this.records.approvalsForTurn(turnId)) {
      this.approvals.get(approval.id)?.('stop');
    }
    const active = this.active.get(turnId);
    if (active) {
      try { await this.runtime.stop(active.runId); }
      finally { active.controller.abort(); }
    }
  }

  async createTask(botId: string, title: string): Promise<AgentTask> {
    if (!(await this.records.getBot(botId))) throw new Error(`Unknown bot ${botId}`);
    const now = Date.now();
    const task: AgentTask = { id: randomUUID(), bot_id: botId, title, status: 'todo', note: '', created_at: now, updated_at: now };
    await this.records.createTask(task);
    return task;
  }

  async updateTask(id: string, status: AgentTask['status'], note = ''): Promise<boolean> {
    return this.records.updateTask(id, status, note);
  }

  async createRoutine(botId: string, name: string, prompt: string, schedule: string, timezone = 'UTC'): Promise<AgentRoutine> {
    if (!(await this.records.getBot(botId))) throw new Error(`Unknown bot ${botId}`);
    const routine: AgentRoutine = {
      id: randomUUID(), bot_id: botId, name, prompt, schedule, timezone,
      enabled: 1, last_run_at: null, created_at: Date.now(),
    };
    await this.records.createRoutine(routine);
    await this.registerCron(routine);
    return routine;
  }

  async setRoutineEnabled(id: string, enabled: boolean): Promise<void> {
    const routine = await this.records.getRoutine(id);
    if (!routine) throw new Error(`Unknown routine ${id}`);
    if (enabled) await this.registerCron(routine);
    else {
      await this.runtime.cron.unregister(id);
      this.cronIds.delete(id);
    }
    await this.records.setRoutineEnabled(id, enabled);
  }

  async runRoutine(id: string): Promise<TurnHandle> {
    const routine = await this.records.getRoutine(id);
    if (!routine || !routine.enabled) throw new Error(`Routine ${id} is disabled or missing`);
    await this.records.touchRoutine(id);
    return this.send(routine.bot_id, `[Routine ${routine.name}]\n${routine.prompt}`, 'routine');
  }

  private async registerCron(routine: AgentRoutine): Promise<void> {
    await this.runtime.cron.register({
      id: routine.id, botId: routine.bot_id, schedule: routine.schedule,
      timezone: routine.timezone, prompt: routine.prompt,
    }, async () => { const handle = await this.runRoutine(routine.id); await handle.done; });
    this.cronIds.add(routine.id);
  }
}
