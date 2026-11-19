import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../../../scripts/upstream.mjs', import.meta.url));

export interface UpstreamDrift {
  name: string;
  upstream: string;
  pinned: string;
  latest: string;
  status: string;
  changelog: string | null;
}

export interface UpstreamCheckResult { checked: number; drift: UpstreamDrift[] }

/**
 * The routine's check runner. Production runs `pnpm upstream:check --json` (read-only: it reads
 * upstream.lock.json and upstream/registry.yaml and never writes). Tests inject a scripted fake.
 */
export type UpstreamChecker = () => Promise<UpstreamCheckResult>;

/** Read-only implementation of `pnpm upstream:check --json` with a fixture feed for E2E. */
export async function checkUpstreams(): Promise<UpstreamCheckResult> {
  const { stdout } = await execute(process.execPath, [script, '--json'], {
    windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  const result = stdout.split(/\r?\n/).find((line) => line.startsWith('NMH_UPSTREAM_JSON='));
  if (!result) throw new Error('Upstream checker did not return JSON');
  const entries = JSON.parse(result.slice('NMH_UPSTREAM_JSON='.length)) as UpstreamDrift[];
  return { checked: entries.length, drift: entries.filter((entry) =>
    entry.status === 'bump available' || entry.status === 'review' || entry.status === 'unpinned') };
}

export interface UpstreamRoutineState {
  botId: string | null; lastCheckedAt: number | null; lastDrift: number | null; lastError: string | null;
}

/** Owner-only state of the `neo upstream` routine: the bot for upstream work and the last run. */
export class UpstreamRoutineStore {
  state: UpstreamRoutineState = { botId: null, lastCheckedAt: null, lastDrift: null, lastError: null };
  constructor(private readonly filename: string) {}

  load(): void {
    if (!existsSync(this.filename)) return;
    const saved = JSON.parse(readFileSync(this.filename, 'utf8')) as Partial<UpstreamRoutineState>;
    this.state = { ...this.state, ...saved };
  }

  save(patch: Partial<UpstreamRoutineState>): UpstreamRoutineState {
    const next = { ...this.state, ...patch };
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.filename);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    this.state = next;
    return next;
  }
}
