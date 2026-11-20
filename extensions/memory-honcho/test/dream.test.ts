import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryEntry, MemoryStore } from '@neometaharness/db';
import { Dreamer, plan, type AcceptMode, type DreamL2, type MemoryInboxSink } from '../src/dream.js';

const NOW = Date.UTC(2026, 10, 20);
const DAY = 24 * 60 * 60 * 1000;
let sequence = 0;
const entry = (text: string, patch: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: `id-${++sequence}`, workspace: 'w', subject: 'user', subject_id: 'global', text, source: 'manual',
  provenance: 'test', trust: 'observed', created_at: NOW - DAY + sequence, updated_at: NOW - DAY + sequence, ...patch,
});
const dreamsFile = (directory: string) => {
  const found = readdirSync(directory).filter((name) => existsSync(join(directory, name, 'DREAMS.md')));
  assert.equal(found.length, 1, 'one DREAMS.md per workspace');
  return join(directory, found[0]!, 'DREAMS.md');
};

// plan(): the consolidation rules.
{
  const keep = entry('User prefers green tea', { trust: 'confirmed' });
  const dup = entry('user prefers  GREEN tea');
  const turnA = entry('Done.', { source: 'hermes.turn', subject: 'bot' });
  const turnB = entry('Done.', { source: 'hermes.turn', subject: 'bot' });
  const stale = entry('Maybe the user likes jazz', { trust: 'untrusted', created_at: NOW - 40 * DAY });
  const young = entry('Maybe the user likes polka', { trust: 'untrusted' });
  const corroborated = entry('Deploys happen on Friday');
  const lonely = entry('Single observation');
  const remote = [entry('deploys happen on friday'), entry('Project codename is Papaya', { trust: 'confirmed' }),
    entry('Hello from a turn', { source: 'honcho.turn' })];
  const proposals = plan([keep, dup, turnA, turnB, stale, young, corroborated, lonely], remote, true, NOW);
  const by = (kind: string) => proposals.filter((item) => item.kind === kind);
  assert.deepEqual(by('dedupe').map((item) => item.target), [dup.id], 'only the less trusted duplicate is removed; turns never');
  assert.deepEqual(by('retract').map((item) => item.target), [stale.id], 'only stale uncorroborated candidates are retracted');
  assert.deepEqual(by('promote').map((item) => item.target), [corroborated.id], 'promotion needs corroboration');
  assert.deepEqual(by('sync-l2').map((item) => item.target), [keep.id], 'only confirmed L1 facts missing from L2 are copied');
  const toL1 = by('sync-l1');
  assert.deepEqual(toL1.map((item) => item.text), ['Project codename is Papaya'], 'turns and known facts stay out of L1');
  assert.ok(proposals.every((item) => item.destructive === (item.kind === 'dedupe' || item.kind === 'retract')));
  assert.equal((toL1[0] as { copy?: { trust: string } }).copy?.trust, 'observed', 'crossing layers never raises trust');
  assert.equal(plan([keep], remote, false, NOW).some((item) => item.kind.startsWith('sync')), false, 'no sync without L2');
  console.log('DREAM_UNIT plan rules: dedupe, retract, promote, sync both ways');
}

class FakeL1 implements MemoryStore {
  entries = new Map<string, MemoryEntry>();
  constructor(items: MemoryEntry[]) { for (const item of items) this.entries.set(item.id, item); }
  async list() { return [...this.entries.values()]; }
  async add(draft: Parameters<MemoryStore['add']>[0]) {
    const item = entry(draft.text, { workspace: draft.workspace, subject: draft.subject, subject_id: draft.subjectId,
      source: draft.source, provenance: draft.provenance, trust: draft.trust });
    this.entries.set(item.id, item); return item;
  }
  async update(id: string, changes: Parameters<MemoryStore['update']>[1]) {
    const item = this.entries.get(id); if (!item) return undefined;
    const next = { ...item, ...changes }; this.entries.set(id, next); return next;
  }
  async delete(id: string) { return this.entries.delete(id); }
  async export() { return { 'SOUL.md': '', 'USER.md': '', 'MEMORY.md': '' }; }
}
class FakeL2 implements DreamL2 {
  added: string[] = [];
  constructor(public entries: MemoryEntry[], public state: 'ok' | 'degraded' | 'off' = 'ok') {}
  async status() { return this.state; }
  async list() { return this.entries; }
  async add(draft: Parameters<DreamL2['add']>[0]) { this.added.push(draft.text); return entry(draft.text); }
}
class FakeSink implements MemoryInboxSink {
  items: Parameters<MemoryInboxSink['propose']>[0][] = [];
  constructor(public mode: AcceptMode) {}
  acceptMode() { return this.mode; }
  propose(input: Parameters<MemoryInboxSink['propose']>[0]) { this.items.push(input); return { id: `inbox-${this.items.length}` }; }
}

const home = mkdtempSync(join(tmpdir(), 'nmh-dream-unit-'));
try {
  // observe: a proposal and a DREAMS.md, but no write until it is applied.
  const l1 = new FakeL1([entry('Prefers dark mode', { workspace: 'w' }), entry('Prefers dark mode', { workspace: 'w' })]);
  const l2 = new FakeL2([entry('Prefers dark mode')]);
  const sink = new FakeSink('observe');
  let current: FakeSink | undefined = sink;
  const dreamer = new Dreamer(join(home, 'a'), l2, () => l1, () => current, () => NOW);
  const report = await dreamer.run('w');
  assert.equal(report.status, 'proposed');
  assert.equal(report.inboxId, 'inbox-1');
  assert.equal(sink.items[0]!.destructive, true);
  assert.equal(l1.entries.size, 2, 'nothing is written before approval');
  assert.match(readFileSync(dreamsFile(join(home, 'a')), 'utf8'), /\*\*dedupe\*\* \(destructive\)/);
  assert.equal((await dreamer.run('w')).id, report.id, 'an identical pending dream is not proposed twice');
  assert.equal(sink.items.length, 1);
  const result = await dreamer.apply(report.id);
  assert.deepEqual([result.applied, result.skipped], [2, 0]);
  assert.equal(l1.entries.size, 1);
  assert.equal([...l1.entries.values()][0]!.trust, 'confirmed');
  await assert.rejects(dreamer.apply(report.id), /Dream is applied/);
  assert.equal(dreamer.last('w')?.status, 'applied');
  console.log('DREAM_UNIT observe proposes, apply writes once');

  // A target that changed after the dream is skipped, not overwritten.
  const tabs = entry('Uses tabs', { workspace: 'w' });
  l1.entries.set(tabs.id, tabs);
  l1.entries.set('dup-tabs', { ...entry('Uses tabs'), id: 'dup-tabs' });
  const second = await dreamer.run('w');
  assert.equal(second.status, 'proposed');
  l1.entries.set('dup-tabs', { ...l1.entries.get('dup-tabs')!, text: 'Uses spaces' });
  const partial = await dreamer.apply(second.id);
  assert.ok(partial.skipped >= 1 && l1.entries.has('dup-tabs'), 'a changed target is skipped');
  console.log('DREAM_UNIT changed targets are skipped on apply');

  // reject; act with and without deletions; no Inbox; closed.
  const rejected = new Dreamer(join(home, 'b'), new FakeL2([]), () => new FakeL1([entry('x'), entry('x')]), () => new FakeSink('act'), () => NOW);
  const pending = await rejected.run('w');
  assert.equal(pending.status, 'proposed', 'act still asks before deleting memory');
  rejected.reject(pending.id);
  await assert.rejects(rejected.apply(pending.id), /Dream is rejected/);
  const actL1 = new FakeL1([entry('Corroborated fact')]);
  const actSink = new FakeSink('act');
  const act = await new Dreamer(join(home, 'c'), new FakeL2([entry('corroborated fact')]), () => actL1, () => actSink, () => NOW).run('w');
  assert.equal(act.status, 'applied');
  assert.equal(actSink.items[0]!.applied, true);
  assert.equal([...actL1.entries.values()][0]!.trust, 'confirmed');
  l1.entries.set('dup-again', { ...entry('Prefers dark mode'), id: 'dup-again' });
  current = undefined;
  const undelivered = await dreamer.run('w');
  assert.equal(undelivered.status, 'undelivered', 'without an Inbox the dream is reported, never applied');
  await assert.rejects(dreamer.apply(undelivered.id), /Dream is undelivered/);
  const offline = await new Dreamer(join(home, 'd'), new FakeL2([], 'off'), () => undefined, () => new FakeSink('act'), () => NOW).run('w');
  assert.equal(offline.status, 'empty');
  assert.equal(offline.risks.length, 2, 'missing L1 and L2 are reported as risks');
  dreamer.close();
  await assert.rejects(dreamer.run('w'), /disabled/);
  assert.throws(() => dreamer.reject(report.id), /disabled/);
  console.log('DREAM_UNIT reject, act, undelivered and closed paths');
} finally {
  rmSync(home, { recursive: true, force: true });
}
console.log('DREAM_UNIT PASS');
