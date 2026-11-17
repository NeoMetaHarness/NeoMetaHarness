import type { NeoKernel } from '@neometaharness/kernel';
import type { HermesEvent } from '@neometaharness/contracts';
import type { AgentRuntime, AgentRuntimeEvent, AgentRunRequest, CronRegistration } from './runtime.js';

/** Hermes transport through the kernel's registered routes. Only pinned engine seams are used. */
export class HermesAgentRuntime implements AgentRuntime {
  private readonly profiles = new Map<string, Promise<string>>();
  private readonly runs = new Map<string, string>();
  private readonly jobs = new Map<string, string>();

  constructor(private readonly kernel: Pick<NeoKernel, 'hasRoute' | 'invokeRoute'>) {}

  private async call<T>(path: string, body: object = {}): Promise<T> {
    const route = `/x/engine-hermes/${path}`;
    if (!this.kernel.hasRoute(route)) throw new Error('Hermes extension unavailable');
    return this.kernel.invokeRoute(route, 'RPC', body) as Promise<T>;
  }

  private async profile(botId: string): Promise<string> {
    let inflight = this.profiles.get(botId);
    if (!inflight) {
      inflight = (async () => {
        const name = 'neo_' + botId.replace(/-/g, '').toLowerCase();
        const existing = await this.call<{ profiles: { name: string }[] }>('profiles/list');
        if (!existing.profiles.some((p) => p.name === name)) {
          await this.call('profiles/create', { name });
        }
        return name;
      })();
      this.profiles.set(botId, inflight);
      void inflight.catch(() => this.profiles.delete(botId));
    }
    return inflight;
  }

  async startRun(request: AgentRunRequest): Promise<{ runId: string }> {
    const profile = await this.profile(request.botId);
    const { run_id } = await this.call<{ run_id: string }>('runs/start', { profile, input: request.input });
    this.runs.set(run_id, profile);
    return { runId: run_id };
  }

  async *streamEvents(runId: string, signal: AbortSignal): AsyncIterable<AgentRuntimeEvent> {
    const profile = this.runs.get(runId);
    if (!profile) throw new Error('Unknown Hermes run ' + runId);
    try {
      const events = await this.call<AsyncIterable<HermesEvent>>('runs/events', { profile, runId, signal });
      for await (const event of events) {
        if (event.kind === 'text.delta' && event.textDelta) yield { type: 'delta', text: event.textDelta };
        if (event.type === 'approval.request') {
          const data = (event.payload ?? {}) as Record<string, unknown>;
          yield {
            type: 'approval_requested', requestId: String(data.request_id ?? data.id ?? runId),
            tool: String(data.tool ?? data.tool_name ?? 'terminal'),
            detail: String(data.description ?? data.command ?? 'Hermes requests permission'),
          };
        }
        if (event.type === 'run.completed') { yield { type: 'completed' }; return; }
        if (event.type === 'run.failed' || event.type === 'run.interrupted' || event.type === 'run.cancelled') {
          yield { type: 'failed', reason: event.type }; return;
        }
      }
    } finally {
      this.runs.delete(runId);
    }
  }

  async approve(runId: string, _requestId: string, decision: 'allow' | 'deny'): Promise<void> {
    const profile = this.runs.get(runId);
    if (!profile) throw new Error('Unknown Hermes run ' + runId);
    await this.call('runs/approve', { profile, runId, choice: decision === 'allow' ? 'once' : 'deny' });
  }

  async stop(runId: string): Promise<void> {
    const profile = this.runs.get(runId);
    if (!profile) return;
    try {
      await this.call('runs/stop', { profile, runId });
    } finally {
      this.runs.delete(runId);
    }
  }

  readonly cron = {
    register: async (routine: CronRegistration, _fire: () => Promise<void>): Promise<void> => {
      // Hermes schedules its own agent execution. Reuse a named job on recovery.
      const label = `[Neo routine ${routine.id} bot ${routine.botId} tz ${routine.timezone}]`;
      const jobs = await this.call<Record<string, unknown>[]>('cron/list');
      const existing = jobs.find((job) => String(job.prompt ?? '').startsWith(label));
      const jobId = existing?.id ? String(existing.id) : (await this.call<{ id: string }>('cron/create', {
        prompt: `${label} ${routine.prompt ?? 'Run the scheduled agent routine.'}`, schedule: routine.schedule,
      })).id;
      this.jobs.set(routine.id, jobId);
    },
    unregister: async (id: string): Promise<void> => {
      const jobId = this.jobs.get(id);
      this.jobs.delete(id);
      if (jobId && this.kernel.hasRoute('/x/engine-hermes/cron/delete')) {
        await this.call('cron/delete', { id: jobId });
      }
    },
  };
}
