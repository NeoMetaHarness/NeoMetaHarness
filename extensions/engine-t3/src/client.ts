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

// Small wire projection for the pinned public T3 orchestration RPC seams. The actual
// pinned T3 schemas are checked in test/contracts.entry.ts, not loaded here.
const rpcGroup = RpcGroup.make(
  ...['server.updateSettings', 'vcs.createWorktree', 'terminal.open', 'terminal.close', 'terminal.write'].map((name) =>
    Rpc.make(name, { payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown })),
  Rpc.make('terminal.observe', {
    payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown, stream: true,
  }),
  Rpc.make('orchestration.dispatchCommand', {
    payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown,
  }),
  Rpc.make('orchestration.subscribeThread', {
    payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown, stream: true,
  }),
  Rpc.make('orchestration.subscribeShell', {
    payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown, stream: true,
  }),
  Rpc.make('orchestration.getTurnDiff', {
    payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown,
  }),
  Rpc.make('orchestration.forceStopThread', {
    payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown,
  }),
  Rpc.make('server.getConfig', {
    payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown,
  }),
);

export function t3Origin(origin: string): URL {
  const url = new URL(origin);
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\./.test(url.hostname)
    && /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && loopback)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('T3 requires an HTTPS origin, or HTTP on loopback.');
  }
  return url;
}

type Runtime = ManagedRuntime.ManagedRuntime<any, never>;
export type T3Event = {
  kind: 'snapshot' | 'synchronized' | 'event' | 'unknown-event' | 'text.delta';
  sequence?: number;
  type?: string;
  payload?: unknown;
  textDelta?: string;
  fullText?: boolean;
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
      textDelta: payload.text, fullText: true, payload: event.payload };
  }
  return { kind: 'event', sequence: frame.sequence as number, type: event.type as string, payload: event.payload };
}

export class T3ControlPlane {
  private runtime?: Runtime;
  private scope?: Scope.Closeable;
  private client?: any;
  private readonly subscriptions = new Set<AbortController>();
  private readonly workflowTerminals = new Map<string, { threadId: string; terminalId: string }>();
  private readonly workflowCleanups = new Set<() => Promise<void>>();

  onWorkflowDisconnect(cleanup: () => Promise<void>) {
    this.workflowCleanups.add(cleanup);
    return () => { this.workflowCleanups.delete(cleanup); };
  }

  get connected(): boolean { return !!this.client; }

  /** Fixed public seams used by coding-workflow; never expose arbitrary RPC to clients. */
  async workflowRequest(method: 'server.updateSettings' | 'vcs.createWorktree' | 'terminal.open' | 'terminal.close' | 'terminal.write', input: unknown): Promise<any> {
    if (!this.client || !this.runtime) throw new Error('T3 is disconnected');
    const result = await this.runtime.runPromise(this.client[method](input));
    const terminal = input as { threadId: string; terminalId: string };
    if (method === 'terminal.open') this.workflowTerminals.set(terminal.terminalId, terminal);
    if (method === 'terminal.close') this.workflowTerminals.delete(terminal.terminalId);
    return result;
  }

  workflowCommand(command: Record<string, unknown>) { return this.dispatch(command); }

  async *terminalOutput(input: { threadId: string; terminalId: string }, signal?: AbortSignal): AsyncGenerator<any> {
    if (!this.client || !this.runtime) throw new Error('T3 is disconnected');
    const iterable = Stream.toAsyncIterable(this.client['terminal.observe'](input));
    for await (const item of iterable) {
      if (signal?.aborted) return;
      yield item;
    }
  }

  async connect(origin: string, scopedSession: string, signal?: AbortSignal, onClose?: () => void): Promise<void> {
    const base = t3Origin(origin);
    const response = await fetch(new URL('/api/auth/websocket-ticket', base), {
      method: 'POST', headers: { Authorization: `Bearer ${scopedSession}` },
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
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
    let closed = false;
    const socketLayer = Socket.layerWebSocket(url.toString()).pipe(Layer.provide(
      Layer.succeed(Socket.WebSocketConstructor, (address) => {
        const socket = new WebSocket(address);
        socket.addEventListener('close', () => {
          closed = true;
          if (this.runtime === runtime) {
            void this.dropConnection().catch(() => {});
            onClose?.();
          }
        }, { once: true });
        return socket;
      }),
    ));
    const protocolLayer = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(socketLayer), Layer.provide(RpcSerialization.layerJson),
    );
    const runtime = ManagedRuntime.make(protocolLayer);
    try {
      const scope = await runtime.runPromise(Scope.make());
      const client = await runtime.runPromise(
        RpcClient.make(rpcGroup).pipe(Effect.provideService(Scope.Scope, scope)),
      );
      await runtime.runPromise(client['server.getConfig']({}).pipe(Effect.timeout('10 seconds')), { signal });
      signal?.throwIfAborted();
      if (closed) throw new Error('T3 closed its connection');
      // Validate the new socket before handing off, so failed renewal leaves the old socket serving.
      const previous = this.dropConnection();
      this.scope = scope;
      this.runtime = runtime;
      this.client = client;
      void previous.catch(() => {});
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
    // T3's ProviderApprovalDecision accepts `accept`, while Neo exposes `approve`.
    return this.dispatch({ type: 'runtime-request.respond', ...input,
      decision: input.decision === 'approve' ? 'accept' : 'decline' });
  }

  settle(threadId: string) { return this.dispatch({ type: 'thread.settle', threadId }); }

  async listThreads() {
    if (!this.client || !this.runtime) throw new Error('T3 is disconnected');
    // The initial shell stream frame is a snapshot. Returning ends the subscription.
    for await (const value of Stream.toAsyncIterable(this.client['orchestration.subscribeShell']({}))) {
      const frame = value as { kind?: string; snapshot?: { projects: unknown[]; threads: unknown[] } };
      if (frame.kind !== 'snapshot' || !frame.snapshot) continue;
      const snapshot = frame.snapshot;
      return {
        projects: (snapshot.projects as any[]).map((project) => ({
          id: project.id, title: project.title, workspaceRoot: project.workspaceRoot,
          defaultModelSelection: project.defaultModelSelection ?? null,
        })),
        threads: (snapshot.threads as any[]).map((thread) => ({
          id: thread.id, projectId: thread.projectId, title: thread.title, status: thread.status,
          activeRunId: thread.activeRunId, itemCount: thread.itemCount,
          worktreePath: thread.worktreePath, branch: thread.branch,
          pendingRuntimeRequest: thread.pendingRuntimeRequest
            ? { id: thread.pendingRuntimeRequest.id, kind: thread.pendingRuntimeRequest.kind } : null,
        })),
      };
    }
    throw new Error('T3 shell snapshot unavailable');
  }

  async diff(input: { threadId: string; fromTurnCount: number; toTurnCount: number; ignoreWhitespace?: boolean }) {
    if (!this.client || !this.runtime) throw new Error('T3 is disconnected');
    return this.runtime.runPromise(this.client['orchestration.getTurnDiff'](input));
  }

  async listProviders() {
    if (!this.client || !this.runtime) throw new Error('T3 is disconnected');
    // T3 v0.1.9 packages/contracts/src/rpc.ts:647 and server.ts:207-271.
    // Expose only routing and display metadata, never auth/config/settings.
    const config: any = await this.runtime.runPromise(this.client['server.getConfig']({}));
    const providers = Array.isArray(config?.providers) ? config.providers : [];
    return { providers: providers.filter((provider: any) => provider.enabled && provider.installed && provider.status !== 'disabled')
      .map((provider: any) => ({
        id: String(provider.instanceId), name: String(provider.displayName || provider.instanceId),
        status: String(provider.status),
        models: (Array.isArray(provider.models) ? provider.models : []).map((model: any) => ({
          id: String(model.slug), name: String(model.name), isDefault: model.isDefault === true,
        })),
      })) };
  }

  rollback(input: { threadId: string; scopeId: string; checkpointId: string }) {
    // T3 v0.1.9 packages/contracts/src/orchestrationV2.ts:3334-3340.
    // Do not modify shared workspace files (CheckpointRestoreSafety.ts:10-11).
    return this.dispatch({ type: 'checkpoint.rollback', ...input, restoreFiles: false });
  }

  async stop(input: { threadId: string; runId?: string }) {
    if (!this.client || !this.runtime) throw new Error('T3 is disconnected');
    return this.runtime.runPromise(this.client['orchestration.forceStopThread'](input));
  }

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

  private async dropConnection(): Promise<void> {
    const { runtime, scope } = this;
    this.client = this.runtime = this.scope = undefined;
    for (const controller of this.subscriptions) controller.abort();
    this.subscriptions.clear();
    try {
      if (runtime && scope) await runtime.runPromise(Scope.close(scope, Exit.void));
    } finally {
      await runtime?.dispose();
    }
  }

  async disconnect(graceful = true): Promise<void> {
    const cleanups = [...this.workflowCleanups];
    this.workflowCleanups.clear();
    if (graceful) {
      for (const cleanup of cleanups) await cleanup().catch(() => {});
    }
    const { client, runtime } = this;
    const terminals = [...this.workflowTerminals.values()];
    this.workflowTerminals.clear();
    if (!graceful) {
      const disconnected = this.dropConnection();
      await Promise.all([disconnected, ...cleanups.map((cleanup) => cleanup().catch(() => {}))]);
      return;
    }
    if (runtime && client && terminals.length > 0) {
      await Promise.all(terminals.map((terminal) => runtime.runPromise(
        client['terminal.close'](terminal).pipe(Effect.timeout('2 seconds')),
      ).catch(() => {})));
    }
    await this.dropConnection();
  }
}
