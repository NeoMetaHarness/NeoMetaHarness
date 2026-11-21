import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SuccessMetrics } from '../src/metrics.js';

test('seeded finished tickets, traces, skill state and scoped proxy signals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nmh-metrics-'));
  const put = async (file: string, content: unknown) => {
    const path = join(root, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
  };
  const at = Date.parse('2026-11-21T10:00:00Z');
  const item = (id: string, workspace?: string, status = 'ready', extra: Record<string, unknown> = {}) => ({
    id, workspace, text: id, botId: 'bot', mode: 'observe', status, createdAt: at, updatedAt: at,
    episode: { goal: id, steps: [], tools: [], outcome: status, traceId: `trace-${id}` }, ...extra,
  });
  try {
    await put('engine-superagent/inbox.json', [
      item('a-1', 'a'), item('a-2', 'a', 'ready', { approval: { destructive: false, reason: 'approve', decision: 'approved' } }),
      item('a-3', 'a', 'blocked'), item('b-1', 'b'), item('global'),
      item('channel', 'a', 'running', { episode: undefined, source: 'neo/channel', notification: { channelId: 'telegram', deliveredAt: at + 600_000 } }),
    ]);
    await put('engine-superagent/traces/decisions.jsonl', [
      { ticketId: 'a-1', workspace: 'a', chosenAction: 'ticket.complete', trace_id: 'trace-a-1' },
      { ticketId: 'b-1', workspace: 'b', chosenAction: 'ticket.complete', trace_id: 'trace-b-1' },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    await put('skills-registry/assignments.json', [{ name: 'owner/skill' }]);
    await put('skills-registry/evaluations.json', { 'owner/skill@2': { status: 'passed' } });
    await put('skills-registry/repo/skills/owner/skill/metadata.json', { name: 'owner/skill', version: 2 });

    const metrics = new SuccessMetrics(root);
    const a = await metrics.summary({ workspace: 'a' });
    assert.equal(a.finishedTickets, 3);
    assert.equal(a.completedTickets, 2);
    assert.equal(a.attention.share, null);
    assert.equal(a.attention.withRecordedApproval, 1);
    assert.equal(a.attention.observedWithoutFinalApprovalShare, 2 / 3);
    assert.equal(a.learning.promotedPer20, null);
    assert.equal(a.learning.rollbackRate, null);
    assert.equal(a.learning.qualifiedSkills, null);
    assert.equal(a.firstValue.minutes, null);

    const b = await metrics.summary({ workspace: 'b' });
    assert.equal(b.finishedTickets, 1);
    assert.equal(b.completedTickets, 1);
    assert.equal(b.attention.withRecordedApproval, 0);
    assert.equal((await metrics.summary({ workspace: 'missing' })).completedTickets, 0);

    const desktop = await metrics.summary({ onboardingCompletedAt: new Date(at).toISOString() });
    assert.equal(desktop.finishedTickets, 5);
    assert.equal(desktop.completedTickets, 4);
    assert.equal(desktop.learning.qualifiedSkills, 1);
    assert.equal(desktop.firstValue.onboardingToFirstReplyMinutes, 10);
    assert.equal(desktop.firstValue.minutes, null);
    console.log('P7-12_SEEDED PASS scoped tickets, partial signals and unavailable PRD rates');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
