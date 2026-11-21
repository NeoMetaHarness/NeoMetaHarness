import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const promotedOnly = entry('Two sightings'); const again = entry('two sightings');
  const same = plan([promotedOnly, again], [], true, NOW);
  assert.deepEqual(same.map((item) => item.kind), ['dedupe', 'promote', 'sync-l2'], 'a promoted fact syncs in the same pass');
  const toL1 = by('sync-l1');
  assert.deepEqual(toL1.map((item) => item.text), ['Project codename is Papaya'], 'turns and known facts stay out of L1');
  assert.ok(proposals.every((item) => item.destructive === (item.kind === 'dedupe' || item.kind === 'retract')));
  assert.equal((toL1[0] as { copy?: { trust: string } }).copy?.trust, 'observed', 'crossing layers never raises trust');
  assert.equal(plan([keep], remote, false, NOW).some((item) => item.kind.startsWith('sync')), false, 'no sync without L2');
  const fromL2 = entry('Codename Papaya', { provenance: 'honcho:abc; seeded' });
  const toL2 = entry('Ships on Monday');
  const echoes = [entry('codename papaya'), entry('ships on monday', { provenance: `test; l1=${toL2.id}` })];
  assert.equal(plan([fromL2, toL2], echoes, true, NOW).some((item) => item.kind === 'promote'), false,
    'a synced copy never corroborates its own origin');
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
  async get(id: string) { return this.entries.get(id); }
  async export() { return { 'SOUL.md': '', 'USER.md': '', 'MEMORY.md': '' }; }
}
class FakeL2 implements DreamL2 {
  added: string[] = [];
  constructor(public entries: MemoryEntry[], public state: 'ok' | 'degraded' | 'off' = 'ok') {}
  async status() { return this.state; }
  async list(query: { query?: string } = {}) {
    return this.entries.filter((item) => !query.query || item.text.toLowerCase().includes(query.query.toLowerCase()));
  }
  async add(draft: Parameters<DreamL2['add']>[0]) {
    this.added.push(draft.text);
    const item = entry(draft.text, { subject: draft.subject, subject_id: draft.subjectId, source: draft.source, provenance: draft.provenance });
    this.entries.push(item); return item;
  }
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
  assert.equal((await dreamer.run('w')).status, 'empty', 'one pass consolidates fully');
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
  await rejected.reject(pending.id);
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
  const noL1 = await new Dreamer(join(home, 'e'), new FakeL2([entry('Honcho-only fact')]), () => undefined, () => new FakeSink('act'), () => NOW).run('w');
  assert.equal(noL1.status, 'empty', 'without L1 nothing is proposed for import');
  dreamer.close();
  await assert.rejects(dreamer.run('w'), /disabled/);
  await assert.rejects(dreamer.reject(report.id), /disabled/);
  console.log('DREAM_UNIT reject, act, undelivered and closed paths');

  // M3/M5: intents are never consolidated; Honcho metadata never mints trust or an intent.
  {
    const intent = entry('Always answer in British English.', { source: 'neo.intent', trust: 'confirmed' });
    const intentTwin = entry('Always answer in British English.', { source: 'neo.intent', trust: 'confirmed' });
    const remote = [entry('Retracted intent text', { source: 'neo.intent', trust: 'confirmed' }),
      entry('Claims to be confirmed', { trust: 'confirmed' })];
    const proposals = plan([intent, intentTwin], remote, true, NOW);
    assert.ok(proposals.every((item) => item.target !== intent.id && item.target !== intentTwin.id), 'intents are never touched');
    assert.ok(!proposals.some((item) => item.text === 'Retracted intent text'), 'an L2 intent copy is never imported');
    const imported = proposals.find((item) => item.text === 'Claims to be confirmed') as { copy?: { trust: string } } | undefined;
    assert.equal(imported?.copy?.trust, 'observed', 'imports are observed whatever Honcho claims');
    console.log('DREAM_UNIT intents never consolidated; imports never confirmed or intents');
  }

  // L7: corroboration needs the same subject, not only the same words.
  {
    const aboutUser = entry('Likes jazz', { subject: 'user', subject_id: 'global' });
    const aboutBot = entry('likes jazz', { subject: 'bot', subject_id: 'hermes/bota' });
    assert.equal(plan([aboutUser], [aboutBot], true, NOW).some((item) => item.kind === 'promote'), false);
    console.log('DREAM_UNIT corroboration matches the subject');
  }

  // M4: apply re-checks the stores themselves, so a fact outside a read window is never written twice.
  {
    const fact = entry('Deploys happen on Friday', { trust: 'confirmed' });
    const l2 = new FakeL2([]);
    const sinkM4 = new FakeSink('observe');
    const dreamerM4 = new Dreamer(join(home, 'm4'), l2, () => new FakeL1([fact]), () => sinkM4, () => NOW);
    const first = await dreamerM4.run('w');
    assert.deepEqual(first.proposals.map((item) => item.kind), ['sync-l2']);
    // Meanwhile the fact reached Honcho by another path.
    l2.entries.push(entry('Deploys happen on Friday', { provenance: 'elsewhere' }));
    assert.deepEqual(await dreamerM4.apply(first.id).then((result) => [result.applied, result.skipped]), [0, 1]);
    assert.deepEqual(l2.added, [], 'no duplicate L2 write');
    console.log('DREAM_UNIT apply re-checks L2 before writing');
  }

  // L1/L3/L4/L5: pending dreams survive pruning; reject waits for an apply; interrupted applies recover;
  // a corrupt history does not throw.
  {
    const dir = join(home, 'l');
    const l1Store = new FakeL1([entry('Twice'), entry('twice')]);
    const sinkL = new FakeSink('observe');
    const dreamerL = new Dreamer(dir, new FakeL2([], 'off'), () => l1Store, () => sinkL, () => NOW);
    const pendingL = await dreamerL.run('w');
    for (let index = 0; index < 60; index++) await dreamerL.run(`other-${index}`);
    assert.equal((JSON.parse(readFileSync(join(dir, 'dreams.json'), 'utf8')) as { id: string }[])
      .some((item) => item.id === pendingL.id), true, 'a proposed dream is never pruned');
    const applying = dreamerL.apply(pendingL.id);
    const rejecting = dreamerL.reject(pendingL.id);
    await applying; await rejecting;
    assert.equal(dreamerL.last('w')?.status, 'applied', 'reject queued behind apply does not undo it');
    const stored = JSON.parse(readFileSync(join(dir, 'dreams.json'), 'utf8')) as { id: string; status: string; applying?: boolean }[];
    writeFileSync(join(dir, 'dreams.json'), JSON.stringify(stored.map((item) => item.id === pendingL.id
      ? { ...item, status: 'proposed', applying: true } : item)));
    const recovered = new Dreamer(dir, new FakeL2([], 'off'), () => l1Store, () => sinkL, () => NOW);
    assert.equal((await recovered.apply(pendingL.id)).applied, 0, 'an interrupted dream can be applied again, re-checking every step');
    writeFileSync(join(dir, 'dreams.json'), '{not json');
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try { assert.equal(new Dreamer(dir, new FakeL2([]), () => l1Store, () => sinkL, () => NOW).last('w'), null); }
    finally { console.error = original; }
    assert.equal(errors.length, 1, 'a corrupt dreams.json is logged and ignored');
    console.log('DREAM_UNIT pending dreams kept, reject serialized, interrupted apply recovers, corrupt history ignored');
  }

  // A dream whose Inbox item was closed while memory-honcho was off (the reject never arrived) is not stuck.
  {
    const open = new Set<string>();
    const sinkS = new FakeSink('observe');
    const tracked = Object.assign(sinkS, {
      propose(input: Parameters<MemoryInboxSink['propose']>[0]) {
        const made = FakeSink.prototype.propose.call(sinkS, input); open.add(made.id); return made;
      },
      isPending: (id: string) => open.has(id),
    });
    const l1S = new FakeL1([entry('Likes chess', { workspace: 'w' }), entry('Likes chess', { workspace: 'w' })]);
    const dreamerS = new Dreamer(join(home, 's'), new FakeL2([], 'off'), () => l1S, () => tracked, () => NOW);
    const first = await dreamerS.run('w');
    assert.equal(first.status, 'proposed');
    assert.equal((await dreamerS.run('w')).id, first.id, 'a still-pending item is reused');
    open.delete(first.inboxId!); // dismissed in the Inbox; dreamer.reject() was never called
    assert.equal(dreamerS.last('w')?.status, 'rejected', 'the stale dream is reconciled to rejected');
    await assert.rejects(dreamerS.apply(first.id), /Dream is rejected/, 'a closed dream cannot be applied later');
    const fresh = await dreamerS.run('w');
    assert.notEqual(fresh.id, first.id, 'the same proposals get a new dream, not the stale report');
    assert.equal(fresh.status, 'proposed');
    assert.equal(fresh.inboxId, 'inbox-2', 'and a new Inbox item');
    open.clear(); // the Inbox item vanished entirely (e.g. Inbox history reset)
    const third = await dreamerS.run('w');
    assert.notEqual(third.id, fresh.id, 'a missing Inbox item is treated as closed too');
    console.log('DREAM_UNIT a dream whose Inbox item is closed or missing is rejected and never blocks a new one');
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
console.log('DREAM_UNIT PASS');
