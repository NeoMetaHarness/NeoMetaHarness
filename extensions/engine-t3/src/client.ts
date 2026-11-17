import { randomUUID } from 'node:crypto';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import * as Scope from 'effect/Scope';
import * as Exit from 'effect/Exit';
import { Socket } from 'effect/socket';
import { Rpc, RpcClient, RpcGroup, RpcSerialization } from 'effect/rpc';

// Small wire projection for the two public T3 RPC method names. The actual
// pinned T3 schemas are checked in test/contracts.entry.ts, not loaded here.
const rpcGroup = RpcGroup.make(
  Rpc.make('orchestration.dispatchCommand', {
    payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown,
  }),
  Rpc.make('orchestration.subscribeThread', {
    payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown, stream: true,
  }),
);

type Runtime = ManagedRuntime.ManagedRuntime<any, never>;
export type T3Event = {
  kind: 'snapshot' | 'synchronized' | 'event' | 'unknown-event' | 'text.delta';
  sequence?: number;
  type?: string;
  payload?: unknown;
  textDelta?: string;
  messageId?: string;
};

function normalized(raw: unknown): T3Event {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid T3 thread frame');
  const frame = raw as Record<string, unknown>;
  if (frame.kind === 'snapshot') return { kind: 'snapshot', sequence: frame.snapshotSequence as number, payload: frame };
  if (frame.kind === 'synchronized') return { kind: 'synchronized' };
  if (frame.kind === 'unknown-event') return { kind: 'unknown-event', sequence: frame.sequence as number, type: frame.eventType as string };
  if (frame.kind !== 'event' || !frame.event || typeof frame.event !== 'object') throw new Error('Unexpected T3 thread frame');
  const event = frame.event as Record<string, unknown>;
  const payload = event.payload as Record<string, unknown> | undefined;
  if (event.type === 'message.updated' && payload?.role === 'assistant' &&
      typeof payload.id === 'string' && typeof payload.text === 'string') {
    // T3 may send separate fragments for the same message id. Retain the
    // full source payload so clients can also reconcile message revisions.
    return { kind: 'text.delta', sequence: frame.sequence as number, messageId: payload.id,
      textDelta: payload.text, payload: event.payload };
  }
  return { kind: 'event', sequence: frame.sequence as number, type: event.type as string, payload: event.payload };
}

export class T3ControlPlane {
  private runtime?: Runtime;
  private scope?: Scope.Closeable;
  private client?: any;
  private readonly subscriptions = new Set<AbortController>();

  get connected(): boolean { return !!this.client; }

  async connect(origin: string, scopedSession: string): Promise<void> {
    if (this.client) throw new Error('T3 is already connected');
    const base = new URL(origin);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
      throw new Error('T3 origin must be an HTTP(S) origin');
    }
    const response = await fetch(new URL('/api/auth/websocket-ticket', base), {
      method: 'POST', headers: { Authorization: `Bearer ${scopedSession}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`T3 socket ticket failed (${response.status})`);
    const result: unknown = await response.json();
    if (!result || typeof result !== 'object' || typeof (result as { ticket?: unknown }).ticket !== 'string') {
      throw new Error('T3 socket ticket response invalid');
    }
    const url = new URL('/ws', base);
    url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('orchestrationProtocol', '2');
    url.searchParams.set('wsTicket', (result as { ticket: string }).ticket);
    const socketLayer = Socket.layerWebSocket(url.toString()).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
    const protocolLayer = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(socketLayer), Layer.provide(RpcSerialization.layerJson),
    );
    const runtime = ManagedRuntime.make(protocolLayer);
    try {
      const scope = await runtime.runPromise(Scope.make());
      const client = await runtime.runPromise(
        RpcClient.make(rpcGroup).pipe(Effect.provideService(Scope.Scope, scope)),
      );
      this.scope = scope;
      this.runtime = runtime;
      this.client = client;
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }

  private async dispatch(command: Record<string, unknown>): Promise<{ sequence: number }> {
    if (!this.client || !this.runtime) throw new Error('T3 is disconnected');
    const result: any = await this.runtime.runPromise(this.client['orchestration.dispatchCommand']({ commandId: randomUUID(), ...command }));
    if (typeof result?.sequence !== 'number') throw new Error('T3 command acknowledgement invalid');
    return { sequence: result.sequence };
  }

  createThread(input: { threadId: string; projectId: string; title: string; providerId: string; model: string }) {
    return this.dispatch({ type: 'thread.create', threadId: input.threadId,
      createdBy: 'user', creationSource: 'web', projectId: input.projectId, title: input.title,
      modelSelection: { instanceId: input.providerId, model: input.model }, runtimeMode: 'approval-required',
      interactionMode: 'default', branch: null, worktreePath: null });
  }

  sendMessage(input: { threadId: string; text: string; messageId?: string }) {
    return this.dispatch({ type: 'message.dispatch', threadId: input.threadId,
      createdBy: 'user', creationSource: 'web', messageId: input.messageId ?? randomUUID(),
      text: input.text, attachments: [], dispatchMode: { type: 'start_immediately' } });
  }

  respond(input: { threadId: string; requestId: string; decision: 'approve' | 'decline' }) {
    return this.dispatch({ type: 'runtime-request.respond', ...input });
  }

  settle(threadId: string) { return this.dispatch({ type: 'thread.settle', threadId }); }

  async *subscribeThread(threadId: string, signal?: AbortSignal): AsyncGenerator<T3Event> {
    if (!this.client || !this.runtime) throw new Error('T3 is disconnected');
    const abort = new AbortController();
    this.subscriptions.add(abort);
    const stop = () => abort.abort();
    signal?.addEventListener('abort', stop);
    try {
      const stream = this.client['orchestration.subscribeThread']({ threadId });
      const iterable = Stream.toAsyncIterable(stream);
      for await (const item of iterable) {
        if (abort.signal.aborted) return;
        yield normalized(item);
      }
    } finally {
      stop();
      signal?.removeEventListener('abort', stop);
      this.subscriptions.delete(abort);
    }
  }

  async disconnect(): Promise<void> {
    for (const controller of this.subscriptions) controller.abort();
    this.subscriptions.clear();
    this.client = undefined;
    const runtime = this.runtime;
    const scope = this.scope;
    this.scope = undefined;
    this.runtime = undefined;
    if (runtime && scope) await runtime.runPromise(Scope.close(scope, Exit.void));
    await runtime?.dispose();
  }
}
