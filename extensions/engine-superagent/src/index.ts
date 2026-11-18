import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import { defineExtension } from '@neometaharness/kernel';
import type { InboxEvent, InboxItem } from '@neometaharness/contracts';
import { loadPinnedSuperagent } from './pinned.js';
import { modelHubFactory, type ModelFactory, type ModelHubResolver } from './model.js';
import { PresetWorkerHost, type WorkerHost } from './worker-host.js';
import { NeoCronSource, type ScheduledAsk } from './cron-source.js';
import { FakeChannelSource, type ChannelMessage, type ChannelSource } from './channel-source.js';
import { blockedReason } from './ask-policy.js';
import { DecisionLog } from './decision-log.js';

type Report = NonNullable<InboxItem['report']>;
type Postmortem = NonNullable<Report['postmortem']>;
type SkillImporter = { import(input: {
  name: string; content: string; sourceProfile: string; sourcePath: string;
  provenance: string; autonomy: 'suggest'; trust: 'untrusted';
}): Promise<{ name: string }> };
type Candidate = { evalId: string; triggers: { id: string }[] };
type Ticket = { id: string; origin: { triggerId: string }; inputs: { id: string }[] };
type Assignment = { id: string };

const askSchema = z.object({
  text: z.string().min(1), botId: z.string().min(1), mode: z.enum(['observe', 'act']).default('observe'),
  requesterRole: z.enum(['viewer', 'member', 'admin', 'owner']).default('member'),
});

/** The only Neo-specific boundary that can ingest a Source Trigger. */
export class NeoSourceAdapter {
  constructor(private readonly context: { receive(trigger: unknown): unknown | Promise<unknown> },
    private readonly kind = 'neo/app') {}

  async receive(item: InboxItem): Promise<void> {
    const trigger = {
      id: `${this.kind}:${item.id}`, source: this.kind,
      threads: [{ source: this.kind, id: item.id }],
      actor: { source: this.kind, id: 'person' }, human: true,
      addressed: 'direct', at: new Date(item.createdAt).toISOString(),
      text: item.text, meta: { inboxId: item.id, botId: item.botId },
    };
    const result = await this.context.receive(trigger);
    if (result !== 'stored') throw new Error(`Source rejected Trigger: ${String(result)}`);
  }
}

class SuperagentService {
  constructor(private readonly models: ModelFactory, private readonly decisions: DecisionLog,
    private readonly registry: () => SkillImporter | undefined,
    private readonly worker: WorkerHost = new PresetWorkerHost(models)) {}
  private readonly items = new Map<string, InboxItem>();
  private readonly candidates = new Map<string, Candidate>();
  private readonly events: InboxEvent[] = [];
  private readonly listeners = new Set<() => void>();
  private sequence = 0;
  private closed = false;
  private engine: any;
  private readonly sources = new Map<string, NeoSourceAdapter>();
  private readonly unregisterSources: (() => void)[] = [];
  private cron?: NeoCronSource;
  private channel?: ChannelSource;
  private unsubscribeChannel?: () => void;
  private readonly channelReplies = new Map<string, { channelId: string; inReplyTo: string }>();
  private readonly inflight = new Set<Promise<void>>();
  private workerReady?: Promise<void>;
  private workerHome = '';
  private gatewayUrl!: () => string;
  private token?: string;

  async start(home: string, gatewayUrl: () => string, token?: string, channel?: ChannelSource): Promise<void> {
    this.workerHome = home;
    this.gatewayUrl = gatewayUrl;
    this.token = token;
    const upstream = await loadPinnedSuperagent();
    const repo = new upstream.MemoryRepositories();
    const kinds = ['neo/app', 'neo/cron', 'neo/channel'];
    const sourceKinds = kinds.map((kind) => ({
      kind, title: { en: kind, zh: kind },
      description: { en: `Neo source ${kind}`, zh: `Neo source ${kind}` },
      health: [`${kind}-source`], fields: [], schema: z.object({ enabled: z.boolean().default(true) }),
      scope: () => ({ listened: true, observed: false, row: kind }),
    }));
    const settings = { sources: Object.fromEntries(kinds.map((kind) => [kind, { enabled: true, config: {} }])) };
    const board = new upstream.HealthBoard();
    const registry = new upstream.SourceRegistry(() => settings, board);
    for (const kind of sourceKinds) this.unregisterSources.push(registry.register(kind));
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
          const item = this.items.get(ticket.origin.triggerId.split(':')[1]!);
          if (item) this.update(item, { ticketId: ticket.id, status: 'running' });
        }
      },
    });
    // sourceContextOf enforces Source-owned health/config/state boundaries.
    const state = new Map<string, unknown>();
    const sourceRuntime = {
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
    };
    for (const kind of sourceKinds) {
      const context = upstream.sourceContextOf(sourceRuntime, kind);
      this.sources.set(kind.kind, new NeoSourceAdapter(context, kind.kind));
    }
    this.cron = new NeoCronSource(join(home, '..', 'cron.json'), async (job) => {
      await this.ask({ text: job.text, botId: job.botId, mode: job.mode,
        requesterRole: job.requesterRole ?? 'member' }, 'neo/cron');
    });
    await this.cron.start();
    if (channel) {
      this.channel = channel;
      this.unsubscribeChannel = channel.subscribe((message) => this.fromChannel(message));
    }
  }

  private update(item: InboxItem, patch: Partial<InboxItem>): InboxItem {
    const next = { ...item, ...patch, updatedAt: Date.now() };
    this.items.set(next.id, next);
    const event: InboxEvent = { seq: ++this.sequence, item: structuredClone(next) };
    this.events.push(event);
    if (this.events.length > 1000) this.events.shift();
    for (const listener of this.listeners) listener();
    if (next.report && this.channel && this.channelReplies.has(next.id)) {
      const destination = this.channelReplies.get(next.id)!;
      this.channelReplies.delete(next.id);
      const delivery = this.channel.reply({ ...destination, text: next.report.summary });
      void delivery.catch((error) => console.error('Neo channel report delivery failed:', error));
    }
    return next;
  }

  private async finish(item: InboxItem, report: Report): Promise<InboxItem> {
    const complete = report.status === 'ready' || report.status === 'blocked'
      ? { ...report, postmortem: await this.postmortem(item, report) } : report;
    if (this.closed) return this.items.get(item.id) ?? item;
    return this.update(item, { status: report.status, report: complete });
  }

  private async postmortem(item: InboxItem, report: Report): Promise<Postmortem> {
    const started = Date.now();
    let outcome = 'failed';
    let modelId: string | undefined;
    let summary: Postmortem = { worked: report.summary, failed: report.risks.join('; ') || 'None reported', reusable: false };
    try {
      const { adapter, provider, model } = await this.models('eval', item);
      modelId = model;
      const request = createUserMessage({ content: [{ type: 'text', text: JSON.stringify({
        kind: 'postmortem', ticketId: item.ticketId ?? item.id,
        text: item.text, source: item.source, status: report.status,
        summary: report.summary, tests: report.tests, risks: report.risks,
      }) }], source: { kind: 'user' } });
      let response = '';
      for await (const chunk of adapter.stream({ provider, model, messages: [request] })) {
        if (chunk.type === 'block-end' && chunk.block.type === 'text') response += chunk.block.text;
      }
      summary = z.object({ worked: z.string(), failed: z.string(), reusable: z.boolean(),
        procedure: z.string().optional() }).parse(JSON.parse(response));
      if (this.closed) return summary;
      if (summary.reusable && summary.procedure?.trim()) {
        const provenance = `superagent:${item.ticketId ?? item.id}`;
        const name = `ticket-${item.id.replaceAll('-', '').slice(0, 24)}`;
        const content = `---\nname: ${name}\ndescription: Reusable procedure from Neo ticket ${item.id}\nautonomy: suggest\nprovenance: ${provenance}\n---\n\n# Procedure\n\n${summary.procedure.trim()}\n`;
        const registry = this.registry();
        if (registry) {
          const skill = await registry.import({ name, content, sourceProfile: 'superagent',
            sourcePath: provenance, provenance, autonomy: 'suggest', trust: 'untrusted' });
          summary = { ...summary, skill: skill.name };
        }
      }
      outcome = 'ready';
    } catch (error) {
      summary = { ...summary, failed: `${summary.failed}. Post-mortem review: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      if (!this.closed) await this.decisions.record({ ticketId: item.id, source: item.source ?? 'neo/app',
        inputsSummary: item.text.slice(0, 240), candidates: [], chosenAction: 'postmortem',
        modelRole: 'eval', model_id: modelId, latencyMs: Date.now() - started, outcome });
    }
    return summary;
  }

  private async fromChannel(message: ChannelMessage): Promise<void> {
    if (this.closed || !/(^|\s)@neo\b/i.test(message.text)) return;
    const text = message.text.replace(/(^|\s)@neo\b/i, '$1').trim();
    if (!text) return;
    await this.ask({ text, botId: message.botId, mode: message.mode ?? 'act',
      requesterRole: message.memberRole }, 'neo/channel', (item) => {
      this.channelReplies.set(item.id, { channelId: message.channelId, inReplyTo: message.id });
    });
  }

  async ask(input: unknown, source = 'neo/app', onCreated?: (item: InboxItem) => void): Promise<InboxItem> {
    if (this.closed) throw new Error('Superagent is stopped');
    const request = askSchema.parse(input);
    const now = Date.now();
    const item: InboxItem = {
      ...request, id: randomUUID(), source: source as InboxItem['source'], status: 'suggestion', createdAt: now, updatedAt: now,
    };
    this.items.set(item.id, item);
    onCreated?.(item);
    const reason = blockedReason(request.requesterRole, request.mode, request.text);
    if (reason) {
      const report: Report = { status: 'blocked', summary: reason, changes: [], tests: [], risks: [reason], options: [] };
      return this.finish(item, report);
    }
    await this.sources.get(source)!.receive(item);
    this.engine.evaluateDue();
    const triggerId = `${source}:${item.id}`;
    const candidate = this.candidates.get(triggerId);
    if (!candidate) throw new Error('Trigger was not evaluated by the pinned superagent');
    await this.evaluate(item, candidate);
    this.engine.candidateDelivered(candidate.evalId);
    // Observe mode retains the accepted proposal for human approval.
    if (item.mode === 'observe') return this.update(item, { status: 'suggestion' });
    await this.acceptCandidate(item, candidate, source);
    return this.items.get(item.id)!;
  }

  private async evaluate(item: InboxItem, candidate: Candidate): Promise<void> {
    const started = Date.now();
    let outcome = 'failed';
    let modelId: string | undefined;
    try {
      const { adapter, provider, model } = await this.models('eval', item);
      modelId = model;
      const request = createUserMessage({ content: [{ type: 'text', text: JSON.stringify({
        evalId: candidate.evalId, triggerIds: candidate.triggers.map((trigger) => trigger.id),
        botId: item.botId, text: item.text, mode: item.mode,
      }) }], source: { kind: 'user' } });
      let result = '';
      for await (const chunk of adapter.stream({ provider, model, messages: [request] })) {
        if (chunk.type === 'block-end' && chunk.block.type === 'text') result += chunk.block.text;
      }
      outcome = (JSON.parse(result) as { decision: string }).decision === 'accept' ? 'accepted' : 'declined';
      if (outcome !== 'accepted') throw new Error('Superagent Eval declined the proposed ticket');
    } finally {
      await this.decisions.record({ ticketId: item.id, source: item.source ?? 'neo/app',
        inputsSummary: item.text.slice(0, 240), candidates: candidate.triggers.map((trigger) => trigger.id),
        chosenAction: 'eval', modelRole: 'eval', model_id: modelId, latencyMs: Date.now() - started, outcome });
    }
  }

  private async acceptCandidate(item: InboxItem, candidate: Candidate, source = 'neo/app'): Promise<void> {
    const started = Date.now();
    this.engine.decide(`${source}:${item.id}`, {
      kind: 'accept', title: item.text.slice(0, 100), scope: source,
      reason: 'Explicit Ask Neo request', evalId: candidate.evalId,
    });
    this.candidates.delete(`${source}:${item.id}`);
    await this.decisions.record({ ticketId: item.id, source, inputsSummary: item.text.slice(0, 240),
      candidates: [candidate.evalId], chosenAction: 'accept', modelRole: 'eval',
      latencyMs: Date.now() - started, outcome: 'accepted' });
  }

  async accept(input: { id: string }): Promise<InboxItem> {
    const item = this.items.get(input.id);
    if (!item) throw new Error('Suggestion not found');
    if (item.status !== 'suggestion') throw new Error(`Cannot accept ${item.status} ticket`);
    const reason = blockedReason(item.requesterRole ?? 'member', 'act', item.text);
    if (reason) {
      return this.finish(item, { status: 'blocked', summary: reason,
        changes: [], tests: [], risks: [reason], options: [] });
    }
    const candidate = this.candidates.get(`${item.source ?? 'neo/app'}:${item.id}`);
    if (!candidate) throw new Error('Suggestion Eval expired');
    await this.acceptCandidate(item, candidate, item.source);
    return this.items.get(item.id)!;
  }

  list(): InboxItem[] { return [...this.items.values()].map((item) => structuredClone(item)); }
  listDecisions(input: { ticketId?: string; limit?: number }) { return this.decisions.list(input); }

  cronList(): ScheduledAsk[] { return this.cron!.list(); }
  cronCreate(input: unknown): Promise<ScheduledAsk> {
    const parsed = askSchema.extend({ schedule: z.string().min(1) }).parse(input);
    if (parsed.requesterRole === 'viewer') throw new Error('Viewer cannot register schedules');
    return this.cron!.create({ ...parsed, requesterRole: parsed.requesterRole });
  }
  cronDelete(input: { id: string }): Promise<{ deleted: boolean }> { return this.cron!.delete(input.id); }
  async cronFire(input: { id: string }): Promise<{ ok: boolean }> {
    await this.cron!.fire(input.id);
    return { ok: true };
  }

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
    const started = Date.now();
    let outcome = 'failed';
    try {
      this.engine.assignmentStarted(ticketId, assignmentId);
      this.workerReady ??= this.worker.start(this.workerHome, this.gatewayUrl(), this.token);
      await this.workerReady;
      const result = await this.worker.delegate(item.botId, item.text);
      if (this.closed) return;
      outcome = 'ready';
      const report: Report = {
        status: 'ready', summary: result.summary, changes: [], tests: result.tests, risks: result.risks, options: [],
      };
      this.engine.report(ticketId, { state: 'ready', summary: report.summary });
      await this.finish(item, report);
    } catch (error) {
      if (this.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      const status = /disabled|unavailable|interrupted|stopped|unknown|require.*enabled.*engine-hermes/i.test(message)
        ? 'blocked' : 'failed';
      outcome = status;
      const report: Report = { status, summary: `Hermes delegation ${status}: ${message}`, changes: [], tests: [],
        risks: [message], options: [] };
      this.engine.report(ticketId, { state: status, summary: report.summary });
      await this.finish(item, report);
    } finally {
      if (!this.closed) await this.decisions.record({ ticketId: item.id, source: item.source ?? 'neo/app',
        inputsSummary: item.text.slice(0, 240), candidates: [assignmentId], chosenAction: 'delegate',
        modelRole: 'coding', latencyMs: Date.now() - started, outcome });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribeChannel?.();
    await this.cron?.stop();
    for (const listener of this.listeners) listener();
    await this.worker.close();
    await Promise.allSettled([...this.inflight]);
    for (const unregister of this.unregisterSources) unregister();
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

    const models = process.env.NODE_ENV === 'test' && process.env.NMH_SUPERAGENT_TEST_ADAPTER
      ? (await import(process.env.NMH_SUPERAGENT_TEST_ADAPTER) as { createModelFactory: ModelFactory }).createModelFactory
      : modelHubFactory(() => ctx.inject<ModelHubResolver>('modelHub'));
    const service = new SuperagentService(models,
      new DecisionLog(join(dataDir, 'engine-superagent', 'traces')),
      () => ctx.inject<SkillImporter>('skillRegistry'));
    const channel = ctx.inject<ChannelSource>('channelSource')
      ?? (process.env.NODE_ENV === 'test' ? new FakeChannelSource() : undefined);
    await service.start(join(dataDir, 'engine-superagent', 'dsh'), gatewayUrl, apiKeyToken, channel);
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
    ctx.route('decisions/list', ({ body }) => service.listDecisions(body as { ticketId?: string; limit?: number }));
    ctx.route('accept', ({ body }) => service.accept(body as { id: string }));
    ctx.route('cron/list', () => service.cronList());
    ctx.route('cron/create', ({ body }) => service.cronCreate(body));
    ctx.route('cron/delete', ({ body }) => service.cronDelete(body as { id: string }));
    if (process.env.NODE_ENV === 'test') ctx.route('cron/fire', ({ body }) => service.cronFire(body as { id: string }));
    if (process.env.NODE_ENV === 'test' && channel instanceof FakeChannelSource) {
      ctx.route('channel/emit', async ({ body }) => { await channel.emit(body as ChannelMessage); return { ok: true }; });
      ctx.route('channel/replies', () => channel.replies);
    }
    ctx.route('events', ({ body }) => {
      const { since, signal } = body as { since: number; signal?: AbortSignal };
      return service.subscribe(since, signal);
    });
    ctx.health(() => ({ ok: true }));
  },
});
