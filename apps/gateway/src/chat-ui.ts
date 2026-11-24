import { createHash, randomUUID } from 'node:crypto';
import type { A2uiActionResult, T3Event } from '@neometaharness/contracts';
import type { ChatRunBinding, SqliteDatabaseProvider } from '@neometaharness/db';
import type { NeoKernel } from '@neometaharness/kernel';
import { ORPCError } from '@orpc/server';
import type { GatewayAuthContext } from './rbac.js';

type Invoke = (route: string, input: unknown) => Promise<unknown>;
type Actor = { userId: string; workspaceId: string };
type Sender = (text: string) => Promise<A2uiActionResult>;
type T3Turn = {
  actor: Actor;
  messageId: string;
  completedRun?: string;
  revisions: Map<string, string>;
};

const maxText = 128 * 1024;
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'stopped', 'killed']);
const hermesTerminal = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted']);
const segmentsRoute = '/x/a2ui/segments';

export class ChatUi {
  private readonly sending = new Set<string>();
  private readonly t3Turns = new Map<string, T3Turn>();

  constructor(
    private readonly records: SqliteDatabaseProvider['chat'],
    private readonly kernel: Pick<NeoKernel, 'hasRoute' | 'invokeRoute'>,
    private readonly hermes: Invoke,
    private readonly t3: Invoke,
  ) {}

  actor(context: GatewayAuthContext, workspaceId?: string): Actor | undefined {
    if (context.user && workspaceId && context.role && context.role !== 'viewer') {
      return { userId: context.user.id, workspaceId };
    }
  }

  visibleThread(threadId: string, workspaceId?: string) {
    const record = this.records.get(threadId);
    return record?.engine !== 't3' || record.workspace_id === workspaceId;
  }

  requireThread(threadId: string, workspaceId?: string) {
    if (!this.visibleThread(threadId, workspaceId)) throw new ORPCError('NOT_FOUND');
  }

  requireRun(profile: string, runId: string, workspaceId?: string) {
    const record = this.records.forRun(runId);
    if (record && (record.workspace_id !== workspaceId || record.profile !== profile)) throw new ORPCError('NOT_FOUND');
    return record;
  }

  async createT3(input: { threadId: string; interactive?: boolean }, actor?: Actor): Promise<{ sequence: number; threadId?: string }> {
    if (this.records.get(input.threadId)?.engine === 't3') throw new ORPCError('CONFLICT', { message: 'Thread already exists.' });
    if (!input.interactive || !actor || !this.kernel.hasRoute(segmentsRoute)) {
      return await this.t3('create', input) as { sequence: number };
    }
    const threadId = randomUUID();
    const response = await this.t3('create', { ...input, threadId }) as { sequence: number };
    this.records.create(threadId, 't3', actor.workspaceId);
    return { ...response, threadId };
  }

  async sendT3(input: { threadId: string; text: string; messageId?: string; interactive?: boolean }, actor?: Actor) {
    const record = this.records.get(input.threadId);
    if (record?.engine !== 't3') return await this.t3('send', input) as { sequence: number };
    if (record.workspace_id !== actor?.workspaceId) throw new ORPCError('NOT_FOUND');
    return this.serialize(input.threadId, async () => {
      const instructions = input.interactive ? await this.instructions() : undefined;
      const messageId = instructions ? randomUUID() : input.messageId;
      if (instructions && messageId) {
        // Bound memory. Losing a live binding only disables actions on that reply.
        this.t3Turns.delete(input.threadId);
        if (this.t3Turns.size >= 512) this.t3Turns.delete(this.t3Turns.keys().next().value!);
        this.t3Turns.set(input.threadId, { actor, messageId, revisions: new Map() });
      } else {
        this.t3Turns.delete(input.threadId);
      }
      try {
        return await this.t3('send', { ...input, messageId,
          text: instructions ? `${input.text}\n\n${instructions}` : input.text }) as { sequence: number };
      } catch (error) {
        this.t3Turns.delete(input.threadId);
        throw error;
      }
    });
  }

  async sendHermes(input: { profile: string; input: string; conversationId?: string; interactive?: boolean },
    actor?: Actor, expectedRun?: string): Promise<{ run_id: string; conversationId?: string }> {
    const instructions = input.interactive ? await this.instructions() : undefined;
    if (!input.conversationId && (!instructions || !actor)) {
      return await this.hermes('runs/start', { profile: input.profile, input: input.input }) as { run_id: string };
    }
    if (!actor) throw new ORPCError('FORBIDDEN');
    const conversationId = input.conversationId ?? randomUUID();
    if (!input.conversationId) this.records.create(conversationId, 'hermes', actor.workspaceId, input.profile);
    return this.serialize(conversationId, async () => {
      const binding = this.records.get(conversationId);
      if (binding?.engine !== 'hermes' || binding.workspace_id !== actor.workspaceId || binding.profile !== input.profile) {
        throw new ORPCError('NOT_FOUND');
      }
      if (expectedRun && binding.last_run !== expectedRun) throw new ORPCError('CONFLICT', { message: 'Action is stale.' });
      let sessionId: string | undefined;
      if (binding.last_run) {
        const status = await this.hermes('runs/status', { profile: input.profile, runId: binding.last_run }) as {
          status: string; session_id?: string;
        };
        if (!terminal.has(status.status)) throw new ORPCError('CONFLICT', { message: 'The conversation is still running.' });
        if (!status.session_id) throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'Hermes did not report the conversation session.' });
        sessionId = status.session_id;
      }
      const started = await this.hermes('runs/start', {
        profile: input.profile, input: input.input, instructions, sessionId,
      }) as { run_id: string };
      this.records.recordRun(conversationId, started.run_id, actor.userId, Boolean(instructions));
      return { ...started, conversationId };
    });
  }

  async *hermesEvents(stream: AsyncIterable<T3Event>, input: { profile: string; runId: string },
    record?: ChatRunBinding, actor?: Actor): AsyncGenerator<T3Event> {
    let text: string | undefined = record?.interactive ? '' : undefined;
    for await (const event of stream) {
      if (event.type === 'a2ui.message') continue;
      if (event.kind === 'text.delta' && text !== undefined && this.kernel.hasRoute(segmentsRoute)) {
        text = text.length + (event.textDelta?.length ?? 0) <= maxText ? text + (event.textDelta ?? '') : undefined;
      }
      if (event.type === 'run.completed' && text && record) {
        const send: Sender | undefined = actor && record.sender_id === actor.userId ? async (action) => {
          const next = await this.sendHermes({
            profile: input.profile, input: action, conversationId: record.id, interactive: true,
          }, actor, input.runId);
          return { engine: 'hermes', runId: next.run_id, conversationId: record.id };
        } : undefined;
        const segment = await this.decorate(text, input.runId, record.id, actor, input.runId, send);
        if (segment) yield segment;
      }
      yield event;
      if (event.type && hermesTerminal.has(event.type)) return;
    }
  }

  async *t3Events(stream: AsyncIterable<T3Event>, threadId: string, actor?: Actor): AsyncGenerator<T3Event> {
    const bound = this.records.get(threadId)?.engine === 't3';
    const pending = new Map<string, { runId: string; text: string }>();
    for await (const event of stream) {
      if (event.type === 'a2ui.message') continue;
      yield event;
      if (!bound || !this.kernel.hasRoute(segmentsRoute)) { pending.clear(); continue; }
      const turn = this.t3Turns.get(threadId);
      if (event.kind === 'snapshot') {
        pending.clear();
        const projection = (event.payload as { projection?: {
          runs?: Array<{ id: string; status: string; userMessageId: string }>;
          messages?: Array<{ id: string; runId: string | null; text: string; role: string }>;
        } })?.projection;
        const completed = new Map(projection?.runs?.filter((run) => run.status === 'completed').map((run) => [run.id, run]));
        for (const entry of projection?.messages?.slice(-64) ?? []) {
          if (entry.role !== 'assistant' || !entry.runId || !completed.has(entry.runId)) continue;
          const current = turn && projection?.runs?.at(-1)?.id === entry.runId &&
            completed.get(entry.runId)?.userMessageId === turn.messageId;
          if (current) turn.completedRun = entry.runId;
          const segment = await this.t3Segment(threadId, entry, actor, current ? turn : undefined);
          if (segment) yield segment;
        }
        continue;
      }
      if (!turn) continue;
      const payload = event.payload as { id?: string; runId?: string; userMessageId?: string; status?: string } | undefined;
      if (event.kind === 'text.delta' && event.messageId && payload?.runId && event.textDelta !== undefined) {
        const previous = pending.get(event.messageId);
        const size = (event.fullText ? 0 : previous?.text.length ?? 0) + event.textDelta.length;
        if (size > maxText) { pending.delete(event.messageId); continue; }
        if (!previous && pending.size >= 32) continue;
        pending.set(event.messageId, { runId: payload.runId,
          text: event.fullText ? event.textDelta : (previous?.text ?? '') + event.textDelta });
      }
      if (event.type !== 'run.updated' || !payload?.id || !payload.status) continue;
      if (!(terminal.has(payload.status))) {
        if (turn.completedRun && payload.id !== turn.completedRun) this.t3Turns.delete(threadId);
        continue;
      }
      if (payload.userMessageId === turn.messageId && payload.status === 'completed') {
        turn.completedRun = payload.id;
        for (const [id, entry] of pending) {
          if (entry.runId !== payload.id) continue;
          const segment = await this.t3Segment(threadId, { id, ...entry }, actor, turn);
          if (segment) yield segment;
        }
      }
      for (const [id, entry] of pending) if (entry.runId === payload.id) pending.delete(id);
    }
  }

  private async t3Segment(threadId: string, entry: { id: string; text: string }, actor?: Actor, turn?: T3Turn) {
    const revision = createHash('sha256').update(entry.text).digest('hex');
    const matchingActor = actor && turn && actor.userId === turn.actor.userId && actor.workspaceId === turn.actor.workspaceId;
    if (matchingActor) turn.revisions.set(entry.id, revision);
    const send: Sender | undefined = matchingActor ? async (text) => {
      if (this.t3Turns.get(threadId) !== turn || turn.revisions.get(entry.id) !== revision) {
        throw new ORPCError('CONFLICT', { message: 'Action is stale.' });
      }
      const result = await this.sendT3({ threadId, text, interactive: true }, actor);
      return { engine: 't3', ...result };
    } : undefined;
    return this.decorate(entry.text, entry.id, threadId, actor, `${entry.id}:${revision}`, send);
  }

  private async decorate(text: string, messageId: string, conversationId: string, actor?: Actor, revision?: string,
    send?: Sender): Promise<T3Event | undefined> {
    if (text.length > maxText || !text.includes('a2ui') || !this.kernel.hasRoute(segmentsRoute)) return;
    const target = actor && revision && send ? { actor, conversationId, revision, send } : undefined;
    try {
      const segments = await this.kernel.invokeRoute(segmentsRoute, 'RPC', { text, target });
      if (segments) return { kind: 'event', type: 'a2ui.message', messageId, payload: segments };
    } catch {
      // Chat remains readable if the optional extension is disabled or fails.
    }
  }

  private async instructions(): Promise<string | undefined> {
    const path = '/x/a2ui/instructions';
    if (!this.kernel.hasRoute(path)) return;
    try { return await this.kernel.invokeRoute(path, 'RPC') as string; }
    catch { return undefined; }
  }

  private async serialize<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.sending.has(id)) throw new ORPCError('CONFLICT', { message: 'A message is already being sent.' });
    this.sending.add(id);
    try { return await work(); }
    finally { this.sending.delete(id); }
  }
}
