import type { ComputerMcpBridge, SkillsBridge } from '@neometaharness/kernel';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import { defineExtension } from '@neometaharness/kernel';
import type { AcceptMode, InboxEvent, InboxItem } from '@neometaharness/contracts';
import type { VaultService } from '@neometaharness/vault';
import { loadPinnedSuperagent } from './pinned.js';
import { modelHubFactory, type ModelFactory, type ModelHubResolver } from './model.js';
import { ModelRouteRejected } from '../../models/src/hub.js';
import { PresetWorkerHost, type WorkerHost } from './worker-host.js';
import { NeoCronSource, type ScheduledAsk } from './cron-source.js';
import { FakeChannelSource, type ChannelMessage, type ChannelSource } from './channel-source.js';
import { blockedReason, isDestructive } from './ask-policy.js';
import { DecisionLog } from './decision-log.js';
import { BridgeKey, BRIDGE_KEY_ROTATE_MS, writeTokenFile, type BridgeKeyHandle } from './bridge-key.js';
import { checkUpstreams } from './upstream-source.js';
import { InboxStore } from './inbox-store.js';
import { PollingGitHubSource, type GitHubConfig, type GitHubEvent, type GitHubSource } from './github-source.js';
import { AcceptModeStore } from './accept-mode.js';

type Role = 'viewer' | 'member' | 'admin' | 'owner';
const isAdmin = (role?: Role) => role === 'admin' || role === 'owner';

type Report = NonNullable<InboxItem['report']>;
type Postmortem = NonNullable<Report['postmortem']>;
type SkillImporter = { import(input: { name: string; content: string; sourceProfile: string },
  origin: { kind: 'agent'; path: string }): Promise<{ name: string }> };
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
  async reportDsh(input: { sessionId: string; workspaceId: string; profile: string;
    turn: string; status: 'ready' | 'failed'; summary: string; question: string }): Promise<void> {
    if (this.closed) return;
    const now = Date.now();
    const report: Report = { status: input.status, summary: input.summary.slice(0, 2000),
      changes: [], tests: [], risks: [], options: [] };
    const item: InboxItem = { id: randomUUID(), botId: input.profile, source: 'neo/dsh',
      requesterRole: 'member', mode: 'observe', status: input.status,
      text: input.question.slice(0, 1000) || `DSH ${input.profile} session ${input.sessionId}`,
      report, createdAt: now, updatedAt: now };
    await this.finish(item, report);
  }
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
  private readonly assignments = new Map<string, string>();
  private readonly terminalReports = new Set<string>();
  private playbookQueue: Promise<void> = Promise.resolve();
  private readonly upstreamItems = new Map<string, string>();
  private github?: GitHubSource;
  private workerReady?: Promise<void>;
  private workerHome = '';
  private gatewayUrl!: () => string;
  /** Path of the bridge API key file handed to the worker (SEC-11). */
  private token?: string;
  private inboxStore?: InboxStore;
  private acceptModes!: AcceptModeStore;
  private acceptModeStored = false;

  async start(home: string, gatewayUrl: () => string, tokenFile?: string, channel?: ChannelSource): Promise<void> {
    this.inboxStore = new InboxStore(join(home, '..', 'inbox.json'));
    for (const item of this.inboxStore.load()) this.items.set(item.id, item);
    this.acceptModes = new AcceptModeStore(join(home, '..', 'accept-mode.json'));
    this.acceptModeStored = this.acceptModes.load();
    this.workerHome = home;
    this.gatewayUrl = gatewayUrl;
    this.token = tokenFile;
    const upstream = await loadPinnedSuperagent();
    const repo = new upstream.MemoryRepositories();
    const kinds = ['neo/app', 'neo/cron', 'neo/channel', 'neo/upstream', 'neo/github'];
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
      if (job.botId === 'neo-system' && job.text === '@neo/upstream check') {
        await this.checkUpstream();
        return;
      }
      await this.ask({ text: job.text, botId: job.botId, mode: job.mode,
        requesterRole: job.requesterRole ?? 'member' }, 'neo/cron');
    });
    await this.cron.start();
    if (!this.cron.list().some((job) => job.botId === 'neo-system' && job.text === '@neo/upstream check')) {
      await this.cron.create({ botId: 'neo-system', text: '@neo/upstream check', mode: 'observe',
        schedule: '0 9 * * 1', requesterRole: 'owner' });
    }
    if (channel) {
      this.channel = channel;
      this.unsubscribeChannel = channel.subscribe((message) => this.fromChannel(message));
    }
  }

  private update(item: InboxItem, patch: Partial<InboxItem>): InboxItem {
    const next = { ...item, ...patch, updatedAt: Date.now() };
    this.items.set(next.id, next);
    this.inboxStore?.save([...this.items.values()]);
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
    if (item.source === 'neo/github' && item.github?.kind === 'comment' && item.github.issue
      && item.mode === 'act' && complete.status === 'ready' && !item.github.posted) {
      // act delivers the reply itself; act-with-approval, and Suggestions accepted under observe, wait for an admin.
      let failure = '';
      if (item.acceptMode === 'act' && !item.destructive && this.github) {
        try {
          await this.github.reply(item.github.repo, item.github.issue, complete.summary);
          return this.recordEpisode(item, complete, { status: 'ready', report: complete,
            github: { ...item.github, posted: true } });
        } catch (error) {
          failure = `Automatic GitHub reply failed (${error instanceof Error ? error.message : String(error)}). `;
        }
      }
      return this.update(item, { status: 'approval', kind: 'approval', report: complete,
        approval: { destructive: true, reason: `${failure}Approve posting this report as a GitHub comment` } });
    }
    return this.recordEpisode(item, complete, { status: report.status, report: complete });
  }

  private async recordEpisode(item: InboxItem, complete: Report, patch: Partial<InboxItem>): Promise<InboxItem> {
    if (complete.status !== 'ready' && complete.status !== 'blocked' && complete.status !== 'failed') {
      return this.update(item, patch);
    }
    const prior = await this.decisions.list({ ticketId: item.id, limit: 20 });
    const traceId = await this.decisions.record({ ticketId: item.id, source: item.source ?? 'neo/app',
      inputsSummary: item.text.slice(0, 240), candidates: [], chosenAction: 'ticket.complete',
      modelRole: 'eval', latencyMs: 0, outcome: complete.status });
    const episode: InboxItem['episode'] = {
      goal: item.text.slice(0, 1000),
      steps: [...new Set([...prior.slice().reverse().map((entry) => entry.chosenAction),
        ...(this.assignments.has(item.id) ? ['delegate'] : []), 'ticket.complete'])],
      tools: [...new Set([
        ...prior.filter((entry) => !entry.model_id.startsWith('policy:')).map((entry) => entry.model_id),
        ...(this.assignments.has(item.id) ? ['hermes-worker'] : []),
        ...(item.source === 'neo/dsh' ? ['dsh-session'] : []),
      ])],
      outcome: complete.status, traceId,
      ...(complete.status === 'ready' && complete.postmortem?.reusable && complete.postmortem.procedure?.trim()
        ? { procedure: complete.postmortem.procedure.trim() } : {}),
    };
    const finished = this.update(item, { ...patch, episode });
    if (finished.status === 'ready' && episode.procedure) {
      try {
        await this.proposePlaybook(finished);
      } catch (error) {
        const current = this.items.get(item.id);
        if (current?.report && !this.closed) {
          this.update(current, { report: { ...current.report, risks: [...current.report.risks,
            `Playbook proposal pending: ${error instanceof Error ? error.message : String(error)}`] } });
        }
      }
    }
    return this.items.get(item.id) ?? finished;
  }

  private async proposePlaybook(item: InboxItem): Promise<void> {
    const task = this.playbookQueue.then(async () => {
      if (this.closed || !item.episode?.procedure) return;
      const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
      const procedure = normalize(item.episode.procedure);
      const matches = [...this.items.values()].filter((entry) => entry.status === 'ready'
        && entry.episode?.outcome === 'ready'
        && entry.episode.procedure && normalize(entry.episode.procedure) === procedure);
      if (matches.length < 2) return;
      const digest = createHash('sha256').update(procedure).digest('hex').slice(0, 16);
      if (matches.some((entry) => entry.report?.playbook?.provenance === `superagent:playbook:${digest}`)) return;
      const registry = this.registry();
      if (!registry) return;
      const name = `playbook-${digest}`;
      const provenance = `superagent:playbook:${digest}`;
      const tickets = matches.map((entry) => entry.id).sort();
      const content = `---\nname: ${name}\ndescription: Procedure repeated across successful Neo Inbox episodes\nautonomy: suggest\nprovenance: ${provenance}\n---\n\n# Procedure\n\n${item.episode.procedure}\n\n# Evidence\n\n${tickets.map((id) => `- Inbox ticket ${id}`).join('\n')}\n`;
      const skill = await registry.import({ name, content, sourceProfile: 'superagent' },
        { kind: 'agent', path: provenance });
      const current = this.items.get(item.id);
      if (current?.report && !this.closed) {
        this.update(current, { report: { ...current.report,
          playbook: { skill: skill.name, provenance, tickets } } });
      }
    });
    this.playbookQueue = task.catch(() => {});
    await task;
  }

  attachGithub(source: GitHubSource): void { this.github = source; }

  /** A P6-4 install kept its mode on the GitHub source: carry it over once (act was approval-gated there). */
  seedAcceptMode(legacy?: 'observe' | 'act'): void {
    if (this.acceptModeStored || !legacy) return;
    this.acceptModes.set(legacy === 'act' ? 'act-with-approval' : 'observe');
    this.acceptModeStored = true;
  }

  acceptModeGet(): { mode: AcceptMode } { return { mode: this.acceptModes.get() }; }
  acceptModeSet(input: { mode: AcceptMode }): { mode: AcceptMode } {
    this.acceptModeStored = true;
    return { mode: this.acceptModes.set(input.mode) };
  }

  /**
   * Inferred Source work follows the workspace accept mode. Without a bot to delegate to, or when the work
   * is destructive, it is always a Suggestion: nothing destructive starts unless an admin accepts it.
   */
  async ingestGithub(event: GitHubEvent): Promise<void> {
    if (this.closed) return;
    const now = Date.now();
    const acceptMode = this.acceptModes.get();
    const github: InboxItem['github'] = { repo: event.repo, url: event.url,
      kind: event.kind, ...(event.kind === 'comment' ? { issue: event.issue } : {}) };
    let text = event.kind === 'comment' ? event.text : '';
    if (event.kind === 'check') {
      const summary = `GitHub check "${event.name}" in ${event.repo} concluded ${event.conclusion}`;
      const item: InboxItem = { id: randomUUID(), text: summary, botId: 'neo-system',
        source: 'neo/github', github, requesterRole: 'owner', mode: 'observe', status: 'failed',
        kind: 'failure', report: { status: 'failed', summary, changes: [], tests: [], risks: [summary], options: [] },
        createdAt: now, updatedAt: now };
      await this.finish(item, item.report!);
      // The failure is the record; the follow-up work is proposed or started per accept mode.
      if (!event.botId) return;
      text = `Investigate failing check "${event.name}" in ${event.repo} (${event.conclusion}): ${event.url}`;
    }
    const destructive = isDestructive(text);
    const mode = acceptMode === 'observe' || destructive || !event.botId ? 'observe' : 'act';
    await this.ask({ text, botId: event.botId ?? 'neo-system', mode, requesterRole: 'owner' }, 'neo/github',
      (created) => { created.github = github; created.acceptMode = acceptMode; created.destructive = destructive; });
  }

  githubPullRequest(input: { repo: string; branch: string; commit: string }) {
    if (!this.github?.pullRequest) throw new Error('GitHub PR lookup unavailable');
    return this.github.pullRequest(input);
  }

  async githubConfigure(input: GitHubConfig & { token?: string; mode?: 'observe' | 'act' }): Promise<void> {
    if (input.mode === 'act' && !(input.botId ?? (await this.github!.status()).botId)) {
      throw new Error('A bot must be selected for GitHub act mode');
    }
    await this.github!.configure({ repositories: input.repositories, botId: input.botId }, input.token);
    // Legacy P6-4 alias: the per-source mode is now the workspace accept mode.
    if (input.mode) this.acceptModeSet({ mode: input.mode === 'act' ? 'act-with-approval' : 'observe' });
  }
  async githubStatus() { return { ...await this.github!.status(), mode: this.acceptModes.get() }; }
  githubPoll() { return this.github!.poll(); }

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
          const skill = await registry.import({ name, content, sourceProfile: 'superagent' },
            { kind: 'agent', path: provenance });
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
    this.inboxStore?.save([...this.items.values()]);
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
    // Observe mode keeps the proposal as a Suggestion a member accepts or dismisses.
    if (item.mode === 'observe') {
      return this.update(item, { status: 'suggestion', kind: 'suggestion',
        destructive: item.destructive ?? isDestructive(item.text) });
    }
    await this.acceptCandidate(item, candidate, source);
    return this.items.get(item.id)!;
  }

  private async evaluate(item: InboxItem, candidate: Candidate): Promise<void> {
    const started = Date.now();
    let outcome = 'failed';
    let modelId: string | undefined;
    let escalated = false;
    try {
      const initial = await this.models('eval', item);
      modelId = initial.model;
      const request = createUserMessage({ content: [{ type: 'text', text: JSON.stringify({
        evalId: candidate.evalId, triggerIds: candidate.triggers.map((trigger) => trigger.id),
        botId: item.botId, text: item.text, mode: item.mode,
      }) }], source: { kind: 'user' } });
      const evaluateBinding = async (binding: typeof initial, signal?: AbortSignal) => {
        let result = '';
        for await (const chunk of binding.adapter.stream({ provider: binding.provider,
          model: binding.model, messages: [request], signal })) {
          if (chunk.type === 'block-end' && chunk.block.type === 'text') result += chunk.block.text;
        }
        if ((JSON.parse(result) as { decision: string }).decision !== 'accept') {
          throw new ModelRouteRejected('Superagent Eval declined the proposed ticket');
        }
      };
      if (initial.runEscalated) {
        escalated = true;
        await initial.runEscalated({ text: item.text, ticketId: item.id, source: item.source ?? 'neo/app' },
          evaluateBinding, async (entry) => {
            await this.decisions.record({ ticketId: item.id, source: item.source ?? 'neo/app',
              inputsSummary: item.text.slice(0, 240), candidates: candidate.triggers.map((trigger) => trigger.id),
              chosenAction: entry.attempt === 1 ? 'eval' : 'escalate', modelRole: 'eval',
              model_id: `${entry.selection.providerId}/${entry.selection.model}`,
              latencyMs: entry.latencyMs, outcome: entry.outcome,
              attempt: entry.attempt, tier: entry.tier });
          });
      } else {
        await evaluateBinding(initial);
      }
      outcome = 'accepted';
    } catch (error) {
      if (error instanceof ModelRouteRejected) outcome = 'declined';
      throw error;
    } finally {
      if (!escalated) await this.decisions.record({ ticketId: item.id, source: item.source ?? 'neo/app',
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

  /** Accept a Suggestion as `role` (the accepting member; falls back to the requester for in-process callers). */
  async accept(input: { id: string }, role?: Role): Promise<InboxItem> {
    const item = this.items.get(input.id);
    if (!item) throw new Error('Suggestion not found');
    if (item.source === 'neo/upstream') throw new Error('Upstream source is observe-only');
    if (item.status !== 'suggestion') throw new Error(`Cannot accept ${item.status} ticket`);
    if ((item.destructive ?? isDestructive(item.text)) && role && !isAdmin(role)) {
      throw new Error('Accepting destructive work requires admin or owner');
    }
    const reason = blockedReason(role ?? item.requesterRole ?? 'member', 'act', item.text);
    if (reason) {
      return this.finish(item, { status: 'blocked', summary: reason,
        changes: [], tests: [], risks: [reason], options: [] });
    }
    const candidate = this.candidates.get(`${item.source ?? 'neo/app'}:${item.id}`);
    if (!candidate) throw new Error('Suggestion Eval expired');
    // Accepted work acts; how its result is delivered still follows the item's accept mode.
    const accepted = this.update(item, { mode: 'act', kind: undefined });
    try {
      await this.acceptCandidate(accepted, candidate, item.source);
    } catch (error) {
      const current = this.items.get(item.id);
      if (current?.status === 'suggestion') this.update(current, { mode: item.mode, kind: item.kind });
      throw error;
    }
    return this.items.get(item.id)!;
  }

  /** Dismiss a Suggestion: the pinned engine records an `ignore` outcome and nothing starts. */
  async dismiss(input: { id: string; reason?: string }, role?: Role): Promise<InboxItem> {
    const item = this.items.get(input.id);
    if (!item || item.status !== 'suggestion') throw new Error('Only Suggestions can be dismissed');
    const reason = input.reason?.trim() || `Dismissed by ${role ?? 'member'}`;
    const triggerId = `${item.source ?? 'neo/app'}:${item.id}`;
    const candidate = this.candidates.get(triggerId);
    if (candidate) {
      try { this.engine.decide(triggerId, { kind: 'ignore', reason, evalId: candidate.evalId }); }
      catch { /* The Eval already ended upstream; the Inbox record is still dismissed. */ }
      this.candidates.delete(triggerId);
    }
    await this.decisions.record({ ticketId: item.id, source: item.source ?? 'neo/app',
      inputsSummary: reason.slice(0, 240), candidates: candidate ? [candidate.evalId] : [],
      chosenAction: 'dismiss', modelRole: 'eval', latencyMs: 0, outcome: 'dismissed' });
    return this.update(item, { status: 'dismissed', kind: 'suggestion' });
  }

  list(): InboxItem[] { return [...this.items.values()].map((item) => structuredClone(item)); }
  private resume(item: InboxItem, text: string): InboxItem {
    if (!item.ticketId) throw new Error('Ticket does not have an assignment');
    const assignmentId = this.assignments.get(item.id);
    if (!assignmentId) throw new Error('Ticket has no resumable assignment');
    const next = this.update(item, { status: 'running', kind: undefined, report: undefined });
    const work = this.runTicket(item.ticketId, assignmentId, text, true);
    this.inflight.add(work);
    void work.then(() => this.inflight.delete(work), () => this.inflight.delete(work));
    return next;
  }

  reply(input: { id: string; answer: string }): InboxItem {
    const item = this.items.get(input.id);
    if (!item || item.status !== 'question') throw new Error('Ticket is not waiting for an answer');
    return this.resume(item, `${item.text}\nHuman answer: ${input.answer.trim()}`);
  }

  async decideApproval(input: { id: string; decision: 'approve' | 'deny'; reason: string },
    role: 'viewer' | 'member' | 'admin' | 'owner'): Promise<InboxItem> {
    const item = this.items.get(input.id);
    if (!item || item.status !== 'approval') throw new Error('Ticket is not awaiting approval');
    if (item.approval?.destructive && role !== 'admin' && role !== 'owner') {
      throw new Error('Destructive approval requires admin or owner');
    }
    if (item.source === 'neo/github') {
      if (role !== 'admin' && role !== 'owner') throw new Error('GitHub publishing requires admin approval');
      if (input.decision === 'deny') {
        const reason = `GitHub reply denied: ${input.reason.trim()}`;
        const denied = this.update(item, { kind: undefined,
          approval: { destructive: true, reason, decision: 'denied' } });
        return this.finish(denied, { status: 'blocked', summary: reason,
          changes: [], tests: [], risks: [reason], options: [] });
      }
      if (item.mode !== 'act' || !item.github?.issue || item.github.posted || item.report?.status !== 'ready') {
        throw new Error('GitHub reply needs an unposted act report');
      }
      await this.github!.reply(item.github.repo, item.github.issue, item.report.summary);
      return this.recordEpisode(item, item.report, { status: 'ready', kind: undefined,
        github: { ...item.github, posted: true },
        approval: { destructive: true, reason: input.reason.trim(), decision: 'approved' } });
    }
    const approval = { destructive: item.approval?.destructive ?? false, reason: input.reason.trim(),
      decision: (input.decision === 'approve' ? 'approved' : 'denied') as 'approved' | 'denied' };
    const updated = this.update(item, { approval });
    if (input.decision === 'deny') {
      const summary = `Approval denied. ${input.reason.trim()}`;
      return this.finish(updated, { status: 'blocked', summary, changes: [], tests: [], risks: [summary], options: [] });
    }
    return this.resume(updated, `${item.text}\nApproved by ${role}: ${input.reason.trim()}`);
  }

  retry(input: { id: string }): InboxItem {
    const item = this.items.get(input.id);
    if (!item || item.status !== 'failed') throw new Error('Only failed tickets can be retried');
    return this.resume(item, item.text);
  }
  async checkUpstream(): Promise<{ checked: number; drift: number }> {
    if (this.closed) throw new Error('Superagent is stopped');
    const { checked, drift: entries } = await checkUpstreams();
    for (const entry of entries) {
      const upstream = { name: entry.name, pinned: entry.pinned, latest: entry.latest,
        changelog: entry.changelog };
      const summary = `Proposed bump ${entry.name} from ${entry.pinned} to ${entry.latest} and run the suites.`;
      const report: Report = { status: 'ready', summary, changes: [], tests: [], risks: [], options: [] };
      const previousId = this.upstreamItems.get(entry.name);
      const previous = previousId && this.items.get(previousId);
      if (previous) {
        // A dismissed drift stays dismissed until upstream moves again.
        if (previous.status === 'dismissed' && previous.upstream?.latest === entry.latest) continue;
        this.update(previous, { upstream, report, status: 'suggestion' });
        continue;
      }
      const now = Date.now();
      const item: InboxItem = { id: randomUUID(), botId: 'neo-system', mode: 'observe',
        source: 'neo/upstream', requesterRole: 'owner', text: `Upstream drift in ${entry.name}`,
        upstream, status: 'suggestion', report, createdAt: now, updatedAt: now };
      this.upstreamItems.set(entry.name, item.id);
      this.update(item, {});
    }
    return { checked, drift: entries.length };
  }
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

  private async runTicket(ticketId: string, assignmentId: string, text?: string, resume = false): Promise<void> {
    const item = [...this.items.values()].find((value) => value.ticketId === ticketId);
    if (!item || this.closed) return;
    const started = Date.now();
    let outcome = 'failed';
    try {
      this.assignments.set(item.id, assignmentId);
      if (!resume) this.engine.assignmentStarted(ticketId, assignmentId);
      this.workerReady ??= this.worker.start(this.workerHome, this.gatewayUrl(), this.token);
      await this.workerReady;
      const result = await this.worker.delegate(item.botId, text ?? item.text);
      if (this.closed) return;
      if (result.kind === 'question' || result.kind === 'approval') {
        outcome = result.kind;
        const question = result.question || result.summary;
        this.update(item, { kind: result.kind, status: result.kind,
          ...(result.kind === 'approval' ? { approval: {
            destructive: Boolean(result.destructive || isDestructive(item.text)), reason: question,
          } } : {}),
          report: { status: result.kind, summary: result.summary, question,
            changes: [], tests: result.tests, risks: result.risks, options: [] },
        });
        return;
      }
      outcome = 'ready';
      const report: Report = {
        status: 'ready', summary: result.summary, changes: [], tests: result.tests, risks: result.risks, options: [],
      };
      if (!this.terminalReports.has(ticketId)) {
        this.engine.report(ticketId, { state: 'ready', summary: report.summary });
        this.terminalReports.add(ticketId);
      }
      await this.finish(item, report);
    } catch (error) {
      if (this.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      const status = /disabled|unavailable|interrupted|stopped|unknown|require.*enabled.*engine-hermes/i.test(message)
        ? 'blocked' : 'failed';
      outcome = status;
      const report: Report = { status, summary: `Worker delegation ${status}: ${message}`, changes: [], tests: [],
        risks: [message], options: [] };
      if (!this.terminalReports.has(ticketId)) {
        this.engine.report(ticketId, { state: status, summary: report.summary });
        this.terminalReports.add(ticketId);
      }
      await this.finish(this.update(item, { kind: status === 'failed' ? 'failure' : undefined }), report);
    } finally {
      if (!this.closed) await this.decisions.record({ ticketId: item.id, source: item.source ?? 'neo/app',
        inputsSummary: item.text.slice(0, 240), candidates: [assignmentId], chosenAction: 'delegate',
        modelRole: 'coding', latencyMs: Date.now() - started, outcome });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.github?.stop();
    this.unsubscribeChannel?.();
    await this.cron?.stop();
    for (const listener of this.listeners) listener();
    await this.worker.close();
    await Promise.allSettled([...this.inflight]);
    await this.playbookQueue;
    for (const unregister of this.unregisterSources) unregister();
  }
}

export default defineExtension({
  async activate(ctx) {
    const gatewayUrl = ctx.inject<() => string>('gatewayUrl');
    const dataDir = ctx.inject<string>('extensionDataDir');
    const auth = ctx.inject<any>('auth');
    const vault = ctx.inject<VaultService>('vault');
    if (!gatewayUrl || !dataDir || !vault) throw new Error('Superagent needs Gateway, vault and isolated storage');

    // SEC-11: a 7-day member key for a real workspace owner, rotated daily
    // through an owner-only file the MCP bridge re-reads per call. Crash
    // leftovers are swept first. There is no fallback to NMH_GATEWAY_TOKEN:
    // without a key the bridge fails closed.
    const bridgeKey = new BridgeKey(auth);
    const tokenFile = join(dataDir, 'engine-superagent', 'bridge.token');
    let current: BridgeKeyHandle | undefined;
    const rotate = async () => {
      try {
        const next = await bridgeKey.mint();
        if (!next) return;
        await writeTokenFile(tokenFile, next.token);
        const previous = current;
        current = next;
        if (previous) await bridgeKey.revoke(previous.id);
      } catch (err) {
        console.error('Superagent failed to mint its bridge API key:', err);
      }
    };
    await bridgeKey.sweep().catch(() => 0);
    await writeTokenFile(tokenFile, undefined);
    await rotate();
    const rotation = setInterval(() => { void rotate(); }, BRIDGE_KEY_ROTATE_MS);
    rotation.unref();

    const models = process.env.NODE_ENV === 'test' && process.env.NMH_SUPERAGENT_TEST_ADAPTER
      ? (await import(process.env.NMH_SUPERAGENT_TEST_ADAPTER) as { createModelFactory: ModelFactory }).createModelFactory
      : modelHubFactory(() => ctx.inject<ModelHubResolver>('modelHub'));
    const service = new SuperagentService(models,
      new DecisionLog(join(dataDir, 'engine-superagent', 'traces')),
      () => ctx.inject<SkillImporter>('skillRegistry'),
      new PresetWorkerHost(models, ctx.inject<ComputerMcpBridge>('computerMcpBridge'),
        ctx.inject<SkillsBridge>('skillsBridge')));
    const github = new PollingGitHubSource(join(dataDir, 'engine-superagent', 'github.json'),
      vault, (event) => service.ingestGithub(event), fetch,
      process.env.NODE_ENV === 'test' && process.env.NMH_SUPERAGENT_GITHUB_API_URL
        ? process.env.NMH_SUPERAGENT_GITHUB_API_URL : 'https://api.github.com',
      process.env.NODE_ENV === 'test' && process.env.NMH_SUPERAGENT_GITHUB_POLL_INTERVAL_MS
        ? Math.max(200, Number(process.env.NMH_SUPERAGENT_GITHUB_POLL_INTERVAL_MS)) : 120_000);
    service.attachGithub(github);
    const channel = ctx.inject<ChannelSource>('channelSource')
      ?? (process.env.NODE_ENV === 'test' ? new FakeChannelSource() : undefined);
    await service.start(join(dataDir, 'engine-superagent', 'dsh'), gatewayUrl, tokenFile, channel);
    await github.start();
    ctx.provide('dshInboxSink', { report: (input: Parameters<typeof service.reportDsh>[0]) =>
      service.reportDsh(input) });
    // Before the first poll (scheduled on a timer by start) so P6-4 installs keep their behaviour.
    service.seedAcceptMode(github.legacyMode);
    ctx.effect(() => async () => {
      clearInterval(rotation);
      if (current) await bridgeKey.revoke(current.id).catch(() => {});
      await writeTokenFile(tokenFile, undefined).catch(() => {});
      await service.close();
    });
    ctx.route('ask', ({ body }) => service.ask(body));
    ctx.route('list', () => service.list());
    ctx.route('decisions/list', ({ body }) => service.listDecisions(body as { ticketId?: string; limit?: number }));
    ctx.route('accept', ({ body }) => service.accept(body as { id: string }, (body as { role?: Role }).role));
    ctx.route('dismiss', ({ body }) => service.dismiss(body as { id: string; reason?: string }, (body as { role?: Role }).role));
    ctx.route('accept-mode/get', () => service.acceptModeGet());
    ctx.route('accept-mode/set', ({ body }) => service.acceptModeSet(body as { mode: AcceptMode }));
    ctx.route('reply', ({ body }) => service.reply(body as { id: string; answer: string }));
    ctx.route('approval/decide', ({ body }) => service.decideApproval(body as {
      id: string; decision: 'approve' | 'deny'; reason: string;
      role: 'viewer' | 'member' | 'admin' | 'owner';
    }, (body as { role: 'viewer' | 'member' | 'admin' | 'owner' }).role));
    ctx.route('retry', ({ body }) => service.retry(body as { id: string }));
    ctx.route('upstream/check', () => service.checkUpstream());
    ctx.route('github/configure', async ({ body }) => { await service.githubConfigure(body as GitHubConfig & { token?: string }); return { ok: true }; });
    ctx.route('github/pullRequest', ({ body }) => service.githubPullRequest(body as { repo: string; branch: string; commit: string }));
    ctx.route('github/status', () => service.githubStatus());
    ctx.route('github/poll', () => service.githubPoll());
    ctx.route('cron/list', () => service.cronList());
    ctx.route('cron/create', ({ body }) => service.cronCreate(body));
    ctx.route('cron/delete', ({ body }) => service.cronDelete(body as { id: string }));
    if (process.env.NODE_ENV === 'test') ctx.route('cron/fire', ({ body }) => service.cronFire(body as { id: string }));
    // Test hooks: the fake source, or the gateway's channel bus (emit + undelivered replies).
    const testChannel = channel as Partial<{ emit(message: ChannelMessage): Promise<void>; replies: unknown[] }> | undefined;
    if (process.env.NODE_ENV === 'test' && typeof testChannel?.emit === 'function' && Array.isArray(testChannel.replies)) {
      ctx.route('channel/emit', async ({ body }) => { await testChannel.emit!(body as ChannelMessage); return { ok: true }; });
      ctx.route('channel/replies', () => testChannel.replies);
    }
    ctx.route('events', ({ body }) => {
      const { since, signal } = body as { since: number; signal?: AbortSignal };
      return service.subscribe(since, signal);
    });
    ctx.health(() => ({ ok: true }));
  },
});
