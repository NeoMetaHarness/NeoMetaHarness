import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, appendFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionLog } from '../src/decision-log.js';

test('decision reader skips torn JSONL and files removed during archive rotation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nmh-decision-metrics-'));
  const current = join(dir, 'decisions.jsonl');
  const old = `${current}.1`;
  const older = `${current}.2`;
  let removedDuringRead = false;
  const log = new DecisionLog(dir, 1_000_000, 3, async (path) => {
    if (path === old) {
      await unlink(path);
      removedDuringRead = true;
    }
    return readFile(path, 'utf8');
  });
  try {
    const traceId = await log.record({ ticketId: 'good-current', workspace: 'a',
      source: 'neo/cron', inputsSummary: 'request', candidates: [], chosenAction: 'ticket.complete',
      modelRole: 'eval', latencyMs: 2, outcome: 'ready' });
    await appendFile(current, '{"ticketId":"half-written"');
    await writeFile(old, '{"ticketId":"vanishing"}\n');
    await writeFile(older, JSON.stringify({ trace_id: 'old-trace', ticketId: 'good-archive',
      chosenAction: 'ticket.complete', at: 1, workspace: 'a' }) + '\n');

    const items = await log.list({ workspace: 'a', limit: 100 });
    assert.equal(removedDuringRead, true);
    assert.deepEqual(items.map((entry) => entry.ticketId), ['good-current', 'good-archive']);
    assert.equal(items[0]?.trace_id, traceId);
    assert.equal(items[0]?.chosenAction, 'ticket.complete');
    console.log('P7-12_DECISION_LOG PASS torn JSONL and rotated-file ENOENT');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
