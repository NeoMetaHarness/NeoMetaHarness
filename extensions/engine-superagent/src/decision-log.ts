import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Panda's /route trace_id, choice/ranking and /outcome model_id/success/actual_latency_ms.
export type DecisionTrace = {
  trace_id: string;
  ticketId: string;
  /** The item's workspace (P6-10); absent for deployment-level items and records written before P6-10. */
  workspace?: string;
  source: string;
  inputsSummary: string;
  candidates: string[];
  chosenAction: string;
  modelRole: 'default' | 'fast' | 'reasoning' | 'eval' | 'coding';
  attempt?: number;
  tier?: 'default' | 'fast' | 'reasoning' | 'eval' | 'coding';
  latencyMs: number;
  outcome: string;
  model_id: string;
  success: boolean;
  actual_latency_ms: number;
  choice: { model_id: string };
  ranking: { model_id: string }[];
  at: number;
};

export class DecisionLog {
  private readonly path: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(dir: string, private readonly maxBytes = 1_000_000, private readonly archives = 3) {
    this.path = join(dir, 'decisions.jsonl');
  }

  record(input: Omit<DecisionTrace, 'trace_id' | 'at' | 'model_id' | 'success' | 'actual_latency_ms' | 'choice' | 'ranking'> & { model_id?: string }): Promise<string> {
    const modelId = input.model_id ?? `policy:${input.chosenAction}`;
    const trace: DecisionTrace = {
      ...input, trace_id: randomUUID(), at: Date.now(), model_id: modelId,
      success: input.outcome === 'accepted' || input.outcome === 'ready',
      actual_latency_ms: input.latencyMs,
      choice: { model_id: modelId }, ranking: input.model_id ? [{ model_id: modelId }] : [],
    };
    const line = JSON.stringify(trace) + '\n';
    const task = this.pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const size = await stat(this.path).then((info) => info.size).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return 0;
        throw error;
      });
      if (size && size + Buffer.byteLength(line) > this.maxBytes) {
        for (let i = this.archives; i >= 1; i--) {
          const old = i === 1 ? this.path : `${this.path}.${i - 1}`;
          await rename(old, `${this.path}.${i}`).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
      }
      await appendFile(this.path, line, 'utf8');
    });
    this.pending = task.catch(() => {});
    return task.then(() => trace.trace_id);
  }

  /** `workspace` keeps only that workspace's records (records with no workspace are then excluded). */
  async list(input: { ticketId?: string; limit?: number; workspace?: string } = {}): Promise<DecisionTrace[]> {
    await this.pending;
    const paths = [this.path, ...Array.from({ length: this.archives }, (_, i) => `${this.path}.${i + 1}`)];
    const batches = await Promise.all(paths.map(async (path) => {
      const raw = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as DecisionTrace);
    }));
    return batches.flat().filter((entry) => (!input.ticketId || entry.ticketId === input.ticketId)
      && (input.workspace === undefined || entry.workspace === input.workspace))
      .sort((a, b) => b.at - a.at).slice(0, input.limit ?? 100);
  }
}
