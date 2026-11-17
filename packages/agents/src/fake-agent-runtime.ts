import { randomUUID } from 'node:crypto';
import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent, CronRegistration } from './runtime.js';

type Mode = 'instant' | 'manual' | 'approval';
interface FakeRun {
  request: AgentRunRequest;
  events: AgentRuntimeEvent[];
  closed: boolean;
  wake?: () => void;
}

/** Deterministic, subscription-free engine stand-in for integration tests. */
export class FakeAgentRuntime implements AgentRuntime {
  private readonly runs = new Map<string, FakeRun>();
  private readonly modes = new Map<string, Mode>();
  readonly started: Array<{ runId: string; request: AgentRunRequest }> = [];
  readonly decisions: Array<{ runId: string; requestId: string; decision: 'allow' | 'deny' }> = [];
  readonly stopped: string[] = [];
  readonly schedules = new Map<string, { routine: CronRegistration; fire: () => Promise<void> }>();

  readonly cron = {
    register: async (routine: CronRegistration, fire: () => Promise<void>): Promise<void> => {
      this.schedules.set(routine.id, { routine, fire });
    },
    unregister: async (id: string): Promise<void> => { this.schedules.delete(id); },
  };

  setMode(botId: string, mode: Mode): void { this.modes.set(botId, mode); }

  async startRun(request: AgentRunRequest): Promise<{ runId: string }> {
    const runId = randomUUID();
    this.runs.set(runId, { request, events: [], closed: false });
    this.started.push({ runId, request });
    const mode = this.modes.get(request.botId) ?? 'instant';
    if (mode === 'instant') queueMicrotask(() => this.finish(runId, 'fake response'));
    if (mode === 'approval') queueMicrotask(() => this.emit(runId, {
      type: 'approval_requested', requestId: 'approve-' + runId, tool: 'write_file', detail: 'Write example.txt',
    }));
    return { runId };
  }

  async *streamEvents(runId: string, signal: AbortSignal): AsyncIterable<AgentRuntimeEvent> {
    const run = this.requireRun(runId);
    while (!signal.aborted) {
      const event = run.events.shift();
      if (event) { yield event; continue; }
      if (run.closed) break;
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal.removeEventListener('abort', wake);
          if (run.wake === wake) run.wake = undefined;
          resolve();
        };
        run.wake = wake;
        signal.addEventListener('abort', wake, { once: true });
        if (signal.aborted) wake();
      });
    }
  }

  async approve(runId: string, requestId: string, decision: 'allow' | 'deny'): Promise<void> {
    this.decisions.push({ runId, requestId, decision });
    if (decision === 'allow') this.finish(runId, 'approved response');
    else await this.stop(runId);
  }

  async stop(runId: string): Promise<void> {
    this.stopped.push(runId);
    const run = this.requireRun(runId);
    run.closed = true;
    run.wake?.();
  }

  emit(runId: string, event: AgentRuntimeEvent): void {
    const run = this.requireRun(runId);
    if (run.closed) throw new Error('Run is closed');
    run.events.push(event);
    run.wake?.();
    run.wake = undefined;
  }

  finish(runId: string, text?: string): void {
    const run = this.requireRun(runId);
    if (run.closed) return;
    if (text) this.emit(runId, { type: 'delta', text });
    this.emit(runId, { type: 'completed' });
    run.closed = true;
    run.wake?.();
  }

  async fireRoutine(id: string): Promise<void> {
    const job = this.schedules.get(id);
    if (!job) throw new Error(`No registered routine ${id}`);
    await job.fire();
  }

  private requireRun(id: string): FakeRun {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Unknown run ${id}`);
    return run;
  }
}

export function fakeAgentRuntime(): FakeAgentRuntime { return new FakeAgentRuntime(); }
