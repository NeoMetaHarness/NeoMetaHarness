import { execFile } from 'node:child_process';
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

/** Read-only implementation of `pnpm upstream:check --json` with a fixture feed for E2E. */
export async function checkUpstreams(): Promise<{ checked: number; drift: UpstreamDrift[] }> {
  const { stdout } = await execute(process.execPath, [script, '--json'], {
    windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  const result = stdout.split(/\r?\n/).find((line) => line.startsWith('NMH_UPSTREAM_JSON='));
  if (!result) throw new Error('Upstream checker did not return JSON');
  const entries = JSON.parse(result.slice('NMH_UPSTREAM_JSON='.length)) as UpstreamDrift[];
  return { checked: entries.length, drift: entries.filter((entry) =>
    entry.status === 'bump available' || entry.status === 'review' || entry.status === 'unpinned') };
}
