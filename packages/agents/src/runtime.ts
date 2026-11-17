/** Engine-independent contract implemented by an agent-runtime extension such as Hermes. */
export interface AgentRunRequest {
  turnId: string;
  botId: string;
  input: string;
  source: 'user' | 'room' | 'bot' | 'routine';
  roomId?: string;
}

export type AgentRuntimeEvent =
  | { type: 'delta'; text: string }
  | { type: 'approval_requested'; requestId: string; tool: string; detail: string }
  | { type: 'completed' }
  | { type: 'failed'; reason: string };

export interface CronRegistration {
  id: string;
  botId: string;
  schedule: string;
  timezone: string;
  prompt?: string;
}

export interface AgentRuntime {
  startRun(request: AgentRunRequest): Promise<{ runId: string }>;
  streamEvents(runId: string, signal: AbortSignal): AsyncIterable<AgentRuntimeEvent>;
  approve(runId: string, requestId: string, decision: 'allow' | 'deny'): Promise<void>;
  stop(runId: string): Promise<void>;
  cron: {
    register(routine: CronRegistration, fire: () => Promise<void>): Promise<void>;
    unregister(id: string): Promise<void>;
  };
}
