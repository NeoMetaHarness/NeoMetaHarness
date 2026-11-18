import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-tool-testkit';
import { z } from 'zod';
import { defineExtension } from '@neometaharness/kernel';
import type { InboxEvent, InboxItem } from '@neometaharness/contracts';
import { loadPinnedSuperagent } from './pinned.js';

type Report = NonNullable<InboxItem['report']>;
type Candidate = { evalId: string; triggers: { id: string }[] };
type Ticket = { id: string; origin: { triggerId: string }; inputs: { id: string }[] };
type Assignment = { id: string };

const askSchema = z.object({
  text: z.string().min(1), botId: z.string().min(1), mode: z.enum(['observe', 'act']).default('observe'),
});

/** The only Neo-specific boundary that can ingest a Source Trigger. */
export class NeoSourceAdapter {
  constructor(private readonly context: { receive(trigger: unknown): unknown | Promise<unknown> }) {}

  async receive(item: InboxItem): Promise<void> {
    const trigger = {
      id: `neo/app:${item.id}`, source: 'neo/app',
      threads: [{ source: 'neo/app', id: item.id }],
      actor: { source: 'neo/app', id: 'person' }, human: true,
      addressed: 'direct', at: new Date(item.createdAt).toISOString(),
      text: item.text, meta: { inboxId: item.id, botId: item.botId },
    };
    const result = await this.context.receive(trigger);
    if (result !== 'stored') throw new Error(`Source rejected Trigger: ${String(result)}`);
  }
}

/** Deterministic DSH LLM adapter for the upstream Engine's Eval candidate. */
class ScriptedEvalModel extends LlmAdapter {
  constructor(private readonly endpoint?: string) { super(); }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100000 } });
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const prompt = options.messages[0]?.content;
    let decision = 'accept';
    if (this.endpoint) {
      const response = await fetch(this.endpoint + '/evaluate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }), signal: options.signal,
      });
      if (!response.ok) throw new Error(`Scripted DSH Eval HTTP ${response.status}`);
      const result = await response.json() as { decision: string };
      decision = result.decision;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ decision }) } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }

  async evaluate(item: InboxItem, candidate: Candidate): Promise<void> {
    const request = createUserMessage({ content: [{ type: 'text', text: JSON.stringify({
      evalId: candidate.evalId, triggerIds: candidate.triggers.map((trigger) => trigger.id),
      botId: item.botId, text: item.text, mode: item.mode,
    }) }], source: { kind: 'user' } });
    let result = '';
    for await (const chunk of this.stream({ provider: 'neo-eval', model: 'scripted', messages: [request] })) {
      if (chunk.type === 'block-end' && chunk.block.type === 'text') result += chunk.block.text;
    }
    if ((JSON.parse(result) as { decision: string }).decision !== 'accept') {
      throw new Error('Scripted Eval declined the proposed ticket');
    }
  }
}

/** Per-worker DSH preset. The Neo MCP tool never appears on the default or root agent. */
class ScriptedWorkerModel extends LlmAdapter {
  private calls = 0;

  constructor(private tool: string, private readonly args: { botId: string; text: string },
    private readonly endpoint?: string) { super(); }

  selectTool(name: string): void { this.tool = name; }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100000 } });
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const stage = ++this.calls;
    if (stage === 1 && !options.tools?.some((entry) => entry.name === this.tool)) {
      throw new Error('DSH model request was missing the worker MCP tool');
    }
    if (this.endpoint) {
      const response = await fetch(this.endpoint + '/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage, tool: this.tool, args: this.args, tools: options.tools?.map((t) => t.name) }),
        signal: options.signal,
      });
      if (!response.ok) throw new Error(`Scripted DSH model HTTP ${response.status}`);
      const answer = await response.json() as { action: 'delegate' | 'finish' };
      if (answer.action !== (stage === 1 ? 'delegate' : 'finish')) {
        throw new Error(`Unexpected scripted DSH model decision ${answer.action}`);
      }
    }
    if (stage === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'block-end', index: 0, block: {
        type: 'tool-call', id: ToolCallId(randomUUID()), name: this.tool, arguments: JSON.stringify(this.args),
      } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Worker delegation finished.' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

class DshWorker {
  private readonly context = new Context();
  private registration?: { dispose(): Promise<void> };
  private active = new Set<{ dispose(): Promise<void> }>();
  private next = 0;

  async start(home: string, gatewayUrl: string, token?: string): Promise<void> {
    const effectiveToken = token ?? process.env.NMH_GATEWAY_TOKEN;
    await mkdir(home, { recursive: true });
    this.context.baseUrl = import.meta.url;
    await this.context.plugin(Loader);
    await mountAgentLoopTestDependencies(this.context);
    await mountAgentLoopTestHarness(this.context);
    await this.context.plugin(AgentPresets, { default: 'standard' });
    const serverFile = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));
    const mcpModule = import.meta.resolve('@deepseek-ai/dsh-mcp-client');
    this.registration = await this.context.plugin({
      inject: ['agentPresets'],
      async *apply(owner) {
        yield await owner.agentPresets.register({ id: 'standard', plugins: [] });
        yield await owner.agentPresets.register({ id: 'neo-superagent-worker', plugins: [{
          id: 'neo-superagent-mcp', name: mcpModule,
          config: {
            transport: 'stdio', serverName: 'neo', command: process.execPath,
            args: [serverFile, gatewayUrl], cwd: home,
            env: { DSH_HOME: home, ...(effectiveToken ? { NMH_GATEWAY_TOKEN: effectiveToken } : {}) }, toolCallTimeoutMs: 90000,
            failOnStartupError: true, reconnect: { enabled: false },
          },
        }] });
      },
    });
  }

  async delegate(botId: string, text: string): Promise<{ summary: string; tests: string[]; risks: string[] }> {
    const provider = `neo-worker-${randomUUID()}`;
    const adapter = new ScriptedWorkerModel('', { botId, text }, process.env.NMH_SUPERAGENT_MODEL_URL);
    // Every worker has its own model adapter, allowing concurrent assignments.
    const unregister = this.context.llm.registerAdapter([provider], adapter);
    let worker: Awaited<ReturnType<typeof this.context.agents.create>> | undefined;
    try {
      worker = await this.context.agents.create({
        sessionId: SessionId(`neo-superagent-${++this.next}-${randomUUID()}`),
        agentOptions: { provider, model: 'scripted' },
        setup: async (owner) => { await this.context.agentPresets.mount(owner, 'neo-superagent-worker'); },
      });
      this.active.add(worker);
      // DSH normalizes MCP tool names containing dots and adds a stable suffix.
      const available = this.context.tools.schemas(worker.agent).map((entry) => entry.name);
      const matching = available.filter((name) => /^mcp__neo__agents_send_to_bot_[a-f0-9]+$/.test(name));
      if (matching.length !== 1) {
        throw new Error(`DSH worker MCP delegation tool unavailable or ambiguous (available: ${available.join(', ')})`);
      }
      // Adapter choice is tied to this worker; the DSH agent loop selects and
      // executes the MCP tool from a real model turn.
      adapter.selectTool(matching[0]!);
      worker.agent.followup(createUserMessage({
        content: [{ type: 'text', text: JSON.stringify({ botId, text }) }], source: { kind: 'user' },
      }));
      await worker.agent.whenIdle();
      const result = worker.agent.session.snapshotEvents().find((event) => event.type === 'tool/result');
      if (!result) throw new Error('DSH worker did not execute the Hermes MCP tool');
      const output = result.data.message.content.find((part) => part.type === 'text');
      const message = output?.type === 'text' ? output.text : '';
      if (result.data.message.isError) throw new Error(message || 'Hermes MCP tool failed');
      const parsed = JSON.parse(message) as { summary: string; tests?: string[]; risks?: string[] };
      return { summary: parsed.summary, tests: parsed.tests ?? [], risks: parsed.risks ?? [] };
    } finally {
      try {
        if (worker) {
          this.active.delete(worker);
          await worker.dispose();
        }
      } finally {
        unregister();
      }
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.active].map((worker) => worker.dispose()));
    await this.registration?.dispose();
    await this.context.fiber.dispose();
  }
}

class SuperagentService {
  private readonly items = new Map<string, InboxItem>();
  private readonly candidates = new Map<string, Candidate>();
  private readonly events: InboxEvent[] = [];
  private readonly listeners = new Set<() => void>();
  private sequence = 0;
  private closed = false;
  private engine: any;
  private source!: NeoSourceAdapter;
  private unregisterSource?: () => void;
  private readonly worker = new DshWorker();
  private readonly evaluator = new ScriptedEvalModel(process.env.NMH_SUPERAGENT_MODEL_URL);
  private readonly inflight = new Set<Promise<void>>();
  private workerReady?: Promise<void>;
  private workerHome = '';
  private gatewayUrl!: () => string;
  private token?: string;

  async start(home: string, gatewayUrl: () => string, token?: string): Promise<void> {
    this.workerHome = home;
    this.gatewayUrl = gatewayUrl;
    this.token = token;
    const upstream = await loadPinnedSuperagent();
    const repo = new upstream.MemoryRepositories();
    const sourceKind = {
      kind: 'neo/app', title: { en: 'Ask Neo', zh: 'Ask Neo' },
      description: { en: 'Messages from the Neo App', zh: 'Messages from the Neo App' },
      health: ['neo-app-source'], fields: [], schema: z.object({ enabled: z.boolean().default(true) }),
      scope: () => ({ listened: true, observed: false, row: 'app' }),
    };
    const settings = { sources: { 'neo/app': { enabled: true, config: {} } } };
    const board = new upstream.HealthBoard();
    const registry = new upstream.SourceRegistry(() => settings, board);
    this.unregisterSource = registry.register(sourceKind);
    this.engine = new upstream.Engine({
      repo, scope: registry,
      policy: () => ({
        version: 'neo-app-v1', paused: false, evalTimeoutMs: 60000,
        gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct', source: 'neo/app' } }),
        revalidate: () => true, admitsInferred: () => false,
      }),
      assessor: { request: (candidate: Candidate) => {
        for (const trigger of candidate.triggers) this.candidates.set(trigger.id, candidate);
      } },
      executor: {
        start: (ticket: Ticket, assignment: Assignment) => {
          queueMicrotask(() => {
            const work = this.runTicket(ticket.id, assignment.id);
            this.inflight.add(work);
            void work.then(() => this.inflight.delete(work), () => this.inflight.delete(work));
          });
        },
        deliver: (ticket: Ticket, assignment: Assignment) => {
          this.engine.inputsDelivered(ticket.id, assignment.id, ticket.inputs.map((input) => input.id));
        },
        stop: () => {},
      },
      outbox: { send: () => {}, status: () => 'sent', withdraw: () => {} },
      emit: (event: { type: string; data: { ticketId?: string } }) => {
        if (event.type === 'ticket.created' && event.data.ticketId) {
          const ticket = repo.tickets.get(event.data.ticketId) as Ticket;
          const item = this.items.get(ticket.origin.triggerId.replace('neo/app:', ''));
          if (item) this.update(item, { ticketId: ticket.id, status: 'running' });
        }
      },
    });
    // sourceContextOf enforces Source-owned health/config/state boundaries.
    const state = new Map<string, unknown>();
    const context = upstream.sourceContextOf({
      sources: registry, ready: Promise.resolve(), configured: () => true,
      deployment: {}, commands: {}, engine: this.engine, outbox: { send: () => {} },
      receive: (trigger: unknown) => this.engine.receive(trigger),
      store: {
        atomic: (work: () => unknown) => work(),
        get: (key: string) => state.get(key), set: (key: string, value: unknown) => state.set(key, value),
        delete: (key: string) => state.delete(key), keys: (prefix: string) => [...state.keys()].filter((key) => key.startsWith(prefix)),
        threads: { get: repo.threads.get, describe: () => {}, patchMeta: () => {} },
        tickets: { get: repo.tickets.get, open: repo.tickets.open },
        triggers: { get: repo.triggers.get },
        read: { subscribedThreads: () => [], threadTriggers: () => [] },
      },
    }, sourceKind);
    this.source = new NeoSourceAdapter(context);
  }

  private update(item: InboxItem, patch: Partial<InboxItem>): InboxItem {
    const next = { ...item, ...patch, updatedAt: Date.now() };
    this.items.set(next.id, next);
    const event: InboxEvent = { seq: ++this.sequence, item: structuredClone(next) };
    this.events.push(event);
    if (this.events.length > 1000) this.events.shift();
    for (const listener of this.listeners) listener();
    return next;
  }

  async ask(input: unknown): Promise<InboxItem> {
    if (this.closed) throw new Error('Superagent is stopped');
    const request = askSchema.parse(input);
    const now = Date.now();
    const item: InboxItem = {
      ...request, id: randomUUID(), status: 'suggestion', createdAt: now, updatedAt: now,
    };
    this.items.set(item.id, item);
    await this.source.receive(item);
    this.engine.evaluateDue();
    const triggerId = `neo/app:${item.id}`;
    const candidate = this.candidates.get(triggerId);
    if (!candidate) throw new Error('Trigger was not evaluated by the pinned superagent');
    await this.evaluator.evaluate(item, candidate);
    this.engine.candidateDelivered(candidate.evalId);
    // The scripted Eval accepts explicit Ask Neo requests. Observe mode retains
    // the candidate until a person accepts, while act mode proceeds immediately.
    if (item.mode === 'observe') return this.update(item, { status: 'suggestion' });
    this.acceptCandidate(item, candidate);
    return this.items.get(item.id)!;
  }

  private acceptCandidate(item: InboxItem, candidate: Candidate): void {
    this.engine.decide(`neo/app:${item.id}`, {
      kind: 'accept', title: item.text.slice(0, 100), scope: 'neo/app',
      reason: 'Explicit Ask Neo request', evalId: candidate.evalId,
    });
    this.candidates.delete(`neo/app:${item.id}`);
  }

  accept(input: { id: string }): InboxItem {
    const item = this.items.get(input.id);
    if (!item) throw new Error('Suggestion not found');
    if (item.status !== 'suggestion') throw new Error(`Cannot accept ${item.status} ticket`);
    const candidate = this.candidates.get(`neo/app:${item.id}`);
    if (!candidate) throw new Error('Suggestion Eval expired');
    this.acceptCandidate(item, candidate);
    return this.items.get(item.id)!;
  }

  list(): InboxItem[] { return [...this.items.values()].map((item) => structuredClone(item)); }

  async *subscribe(since = 0, signal?: AbortSignal): AsyncGenerator<InboxEvent> {
    let cursor = since;
    let wake: (() => void) | undefined;
    const notify = () => { if (wake) { const resolve = wake; wake = undefined; resolve(); } };
    this.listeners.add(notify);
    signal?.addEventListener('abort', notify);
    try {
      while (!signal?.aborted && !this.closed) {
        const next = this.events.find((event) => event.seq > cursor);
        if (next) { cursor = next.seq; yield next; continue; }
        await new Promise<void>((done) => { wake = done; });
      }
    } finally {
      this.listeners.delete(notify);
      signal?.removeEventListener('abort', notify);
    }
  }

  private async runTicket(ticketId: string, assignmentId: string): Promise<void> {
    const item = [...this.items.values()].find((value) => value.ticketId === ticketId);
    if (!item || this.closed) return;
    try {
      this.engine.assignmentStarted(ticketId, assignmentId);
      this.workerReady ??= this.worker.start(this.workerHome, this.gatewayUrl(), this.token);
      await this.workerReady;
      const result = await this.worker.delegate(item.botId, item.text);
      if (this.closed) return;
      const report: Report = {
        status: 'ready', summary: result.summary, changes: [], tests: result.tests, risks: result.risks, options: [],
      };
      this.engine.report(ticketId, { state: 'ready', summary: report.summary });
      this.update(item, { status: 'ready', report });
    } catch (error) {
      if (this.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      const status = /disabled|unavailable|interrupted|stopped|unknown|require.*enabled.*engine-hermes/i.test(message)
        ? 'blocked' : 'failed';
      const report: Report = { status, summary: `Hermes delegation ${status}: ${message}`, changes: [], tests: [],
        risks: [message], options: [] };
      this.engine.report(ticketId, { state: status, summary: report.summary });
      this.update(item, { status, report });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const listener of this.listeners) listener();
    await this.worker.close();
    await Promise.allSettled([...this.inflight]);
    this.unregisterSource?.();
  }
}

export default defineExtension({
  async activate(ctx) {
    const gatewayUrl = ctx.inject<() => string>('gatewayUrl');
    const dataDir = ctx.inject<string>('extensionDataDir');
    const auth = ctx.inject<any>('auth');
    if (!gatewayUrl || !dataDir) throw new Error('Superagent needs Gateway endpoint and isolated storage');

    let apiKeyToken = process.env.NMH_GATEWAY_TOKEN;
    let apiKeyId: string | undefined;
    if (auth?.api?.createApiKey) {
      try {
        const user = await auth.kysely?.selectFrom('user').select(['id']).executeTakeFirst?.();
        const org = await auth.kysely?.selectFrom('organization').select(['id']).executeTakeFirst?.();
        if (user?.id) {
          const keyRes = await auth.api.createApiKey({
            body: {
              userId: user.id,
              name: 'superagent-bridge',
              rateLimitEnabled: false,
              metadata: { role: 'member', workspaceId: org?.id ?? 'default' },
            },
          });
          if (keyRes?.key) {
            apiKeyToken = keyRes.key;
            apiKeyId = keyRes.id;
          }
        }
      } catch (err) {
        console.error('Superagent failed to mint API key:', err);
      }
    }

    const service = new SuperagentService();
    await service.start(join(dataDir, 'engine-superagent', 'dsh'), gatewayUrl, apiKeyToken);
    ctx.effect(() => async () => {
      if (apiKeyId) {
        if (auth?.api?.deleteApiKey) {
          await auth.api.deleteApiKey({ body: { keyId: apiKeyId } }).catch(() => {});
        }
        if (auth?.kysely) {
          await auth.kysely.deleteFrom('apiKey').where('id', '=', apiKeyId).execute().catch(() => {});
        }
      }
      await service.close();
    });
    ctx.route('ask', ({ body }) => service.ask(body));
    ctx.route('list', () => service.list());
    ctx.route('accept', ({ body }) => service.accept(body as { id: string }));
    ctx.route('events', ({ body }) => {
      const { since, signal } = body as { since: number; signal?: AbortSignal };
      return service.subscribe(since, signal);
    });
    ctx.health(() => ({ ok: true }));
  },
});
