import { readFileSync, writeFileSync } from 'node:fs';
import type { UpstreamChecker, UpstreamCheckResult } from '../src/upstream-source.js';

/**
 * Scripted `neo upstream` checker for tests (NODE_ENV=test + NMH_SUPERAGENT_TEST_UPSTREAM).
 * Each call reads the scenario from NMH_SUPERAGENT_UPSTREAM_SCRIPT ({ checked, drift } or { error })
 * and appends the call to `<script>.calls`, so a test can prove which runner ran. No network, no gh, no npm.
 */
export function createUpstreamChecker(): UpstreamChecker {
  const script = process.env.NMH_SUPERAGENT_UPSTREAM_SCRIPT;
  if (!script) throw new Error('NMH_SUPERAGENT_UPSTREAM_SCRIPT must name the scripted upstream scenario');
  return async () => {
    let calls = 0;
    try { calls = Number(readFileSync(`${script}.calls`, 'utf8')) || 0; } catch { /* first call */ }
    writeFileSync(`${script}.calls`, String(calls + 1));
    const scenario = JSON.parse(readFileSync(script, 'utf8')) as UpstreamCheckResult & { error?: string };
    if (scenario.error) throw new Error(scenario.error);
    return { checked: scenario.checked, drift: scenario.drift };
  };
}
