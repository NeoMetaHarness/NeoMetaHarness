import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryEntry, MemoryStore, MemoryTrust } from '@neometaharness/db';
import type { DreamProposal, DreamReport } from '@neometaharness/contracts';

export type AcceptMode = 'observe' | 'act-with-approval' | 'act';
type Proposal = DreamProposal & {
  /** The L1 state the proposal was made against; apply skips a target that changed since. */
  expect?: { text: string; trust: MemoryTrust };
  /** The L2 entry to copy into L1 (sync-l1 only). */
  copy?: { subject: 'user' | 'bot'; subjectId: string; source: string; provenance: string; trust: MemoryTrust };
};
type Report = Omit<DreamReport, 'proposals'> & { proposals: Proposal[]; fingerprint?: string };

/** The Inbox side, provided by engine-superagent. Without it, a dream is reported but never applied. */
export interface MemoryInboxSink {
  acceptMode(): AcceptMode;
  propose(input: { dreamId: string; workspace: string; summary: string; proposals: number;
    destructive: boolean; applied: boolean; changes: string[]; risks: string[] }): { id: string };
}
/** The L2 operations a dream needs; HonchoStore implements them through the REST v3 seam. */
export interface DreamL2 {
  status(workspace: string): Promise<'ok' | 'degraded' | 'off'>;
  list(query: { workspace: string; limit?: number }): Promise<MemoryEntry[]>;
  add(draft: { workspace: string; subject: 'user' | 'bot'; subjectId: string; text: string;
    source: string; provenance: string; trust: MemoryTrust }): Promise<MemoryEntry>;
}

const STALE_CANDIDATE_MS = 30 * 24 * 60 * 60 * 1000;
const rank: Record<MemoryTrust, number> = { untrusted: 0, observed: 1, confirmed: 2 };
const norm = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
const isTurn = (source: string) => source.endsWith('.turn');
const clip = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * Dreaming: a consolidation pass over L1 (Neo local memory) and L2 (Honcho, through its REST seam).
 * It proposes dedupes, stale-candidate retractions, promotions of corroborated facts and L1 <-> L2
 * sync, writes a DREAMS.md report, and hands the report to the Inbox. Proposals are applied only when
 * the workspace accept mode is `act` and nothing is destructive, or when a person accepts or approves.
 */
export class Dreamer {
  private reports: Report[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly home: string, private readonly l2: DreamL2,
    private readonly l1: () => MemoryStore | undefined, private readonly sink: () => MemoryInboxSink | undefined,
    private readonly now: () => number = Date.now) {
    const file = join(home, 'dreams.json');
    if (existsSync(file)) this.reports = JSON.parse(readFileSync(file, 'utf8')) as Report[];
  }

  close() { this.closed = true; }

  last(workspace: string): DreamReport | null {
    const report = [...this.reports].reverse().find((item) => item.workspace === workspace);
    return report ? publicReport(report) : null;
  }

  /** One dream at a time, so two passes never propose the same change twice. */
  run(workspace: string): Promise<DreamReport> {
    const work = this.queue.then(() => this.dream(workspace));
    this.queue = work.catch(() => {});
    return work;
  }

  /** Apply an accepted or approved dream. Each target is re-checked first; changed ones are skipped. */
  apply(id: string): Promise<{ applied: number; skipped: number; changes: string[] }> {
    const work = this.queue.then(async () => {
      const report = this.find(id);
      if (report.status !== 'proposed') throw new Error(`Dream is ${report.status}`);
      const result = await this.write(report);
      this.save({ ...report, status: 'applied', applied: result.applied, skipped: result.skipped });
      return result;
    });
    this.queue = work.catch(() => {});
    return work;
  }

  reject(id: string): void {
    const report = this.find(id);
    if (report.status === 'proposed') this.save({ ...report, status: 'rejected' });
  }

  private find(id: string): Report {
    if (this.closed) throw new Error('Memory dreaming is disabled');
    const report = this.reports.find((item) => item.id === id);
    if (!report) throw new Error('Dream report not found');
    return report;
  }

  private async dream(workspace: string): Promise<DreamReport> {
    if (this.closed) throw new Error('Memory dreaming is disabled');
    const risks: string[] = [];
    const l1 = this.l1();
    const local = l1 ? await l1.list({ workspace, limit: 500 }) : [];
    if (!l1) risks.push('Neo local memory is disabled; only Honcho was read and nothing is synced into L1.');
    let remote: MemoryEntry[] = [];
    let l2Ready = false;
    const status = await this.l2.status(workspace);
    if (status === 'ok') {
      try { remote = await this.l2.list({ workspace, limit: 500 }); l2Ready = true; }
      catch { risks.push('Honcho could not be read; L1 <-> L2 sync was skipped.'); }
    } else {
      risks.push(status === 'off' ? 'Honcho is not configured for this workspace; L1 <-> L2 sync was skipped.'
        : 'Honcho is degraded; L1 <-> L2 sync was skipped.');
    }
    const proposals = plan(local, remote, l2Ready, this.now());
    const report: Report = { id: randomUUID(), workspace, createdAt: this.now(), status: 'empty',
      proposals, applied: 0, skipped: 0, risks, markdown: '' };
    if (!proposals.length) return this.finish(report);
    // A pending dream with the same proposals is still the answer: no second Inbox item for it.
    report.fingerprint = createHash('sha256').update(JSON.stringify(proposals.map(({ kind, target, expect }) =>
      [kind, target, expect]))).digest('hex');
    const pending = this.reports.find((item) => item.workspace === workspace && item.status === 'proposed'
      && item.fingerprint === report.fingerprint);
    if (pending) return publicReport(pending);

    const destructive = proposals.some((item) => item.destructive);
    const sink = this.sink();
    if (!sink) {
      risks.push('The Inbox (engine-superagent) is disabled, so nothing was proposed or applied.');
      return this.finish({ ...report, status: 'undelivered' });
    }
    const acceptMode = sink.acceptMode();
    report.acceptMode = acceptMode;
    // `act` writes non-destructive dreams directly. Deletions always wait for an admin's approval.
    if (acceptMode === 'act' && !destructive) {
      const result = await this.write(report);
      const applied: Report = { ...report, status: 'applied', applied: result.applied, skipped: result.skipped };
      this.finish(applied);
      return this.deliver(applied, sink, true, result.changes);
    }
    // Saved before the Inbox sees it, so accepting the item always finds the dream.
    const proposed: Report = { ...report, status: 'proposed' };
    this.finish(proposed);
    return this.deliver(proposed, sink, false, proposals.map(describe));
  }

  private deliver(report: Report, sink: MemoryInboxSink, applied: boolean, changes: string[]): DreamReport {
    try {
      const item = sink.propose({ dreamId: report.id, workspace: report.workspace, summary: summary(report),
        proposals: report.proposals.length, destructive: report.proposals.some((entry) => entry.destructive),
        applied, changes, risks: report.risks });
      return this.finish({ ...report, inboxId: item.id });
    } catch {
      // No Inbox item means nobody can approve it, so it is not left pending.
      const risks = [...report.risks, 'The Inbox could not take this report.'];
      return this.finish({ ...report, risks, status: applied ? 'applied' : 'undelivered' });
    }
  }

  private async write(report: Report) {
    const l1 = this.l1();
    const local = new Map((l1 ? await l1.list({ workspace: report.workspace, limit: 500 }) : []).map((entry) => [entry.id, entry]));
    const changes: string[] = [];
    let applied = 0, skipped = 0;
    for (const proposal of report.proposals) {
      try {
        const done = await this.step(report, proposal, l1, local);
        if (done) { applied++; changes.push(describe(proposal)); } else skipped++;
      } catch { skipped++; }
    }
    return { applied, skipped, changes };
  }

  private async step(report: Report, proposal: Proposal, l1: MemoryStore | undefined, local: Map<string, MemoryEntry>) {
    if (proposal.kind === 'sync-l1') {
      if (!l1 || !proposal.copy) return false;
      if ([...local.values()].some((entry) => norm(entry.text) === norm(proposal.text))) return false;
      await l1.add({ workspace: report.workspace, ...proposal.copy, text: proposal.text });
      return true;
    }
    const current = local.get(proposal.target);
    if (!l1 || !current || !proposal.expect || current.text !== proposal.expect.text || current.trust !== proposal.expect.trust) return false;
    if (proposal.kind === 'dedupe' || proposal.kind === 'retract') return l1.delete(current.id);
    if (proposal.kind === 'promote') {
      await l1.update(current.id, { trust: 'confirmed', provenance: `${current.provenance}; promoted by dream ${report.id}` });
      return true;
    }
    // sync-l2: copy a confirmed L1 fact into Honcho, keeping its provenance and a pointer back to L1.
    await this.l2.add({ workspace: report.workspace, subject: current.subject, subjectId: current.subject_id,
      text: current.text, source: current.source, provenance: `${current.provenance}; l1=${current.id}`, trust: current.trust });
    return true;
  }

  private finish(report: Report): DreamReport {
    const markdown = render(report);
    const next = { ...report, markdown };
    this.save(next);
    const directory = join(this.home, createHash('sha256').update(report.workspace).digest('hex').slice(0, 24));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    atomicWrite(join(directory, 'DREAMS.md'), markdown);
    return publicReport(next);
  }

  private save(report: Report) {
    this.reports = [...this.reports.filter((item) => item.id !== report.id), report].slice(-50);
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    atomicWrite(join(this.home, 'dreams.json'), JSON.stringify(this.reports));
  }
}

/** The consolidation rules. Pure, so the proposals for one memory state are always the same. */
export function plan(local: MemoryEntry[], remote: MemoryEntry[], l2Ready: boolean, now: number): Proposal[] {
  const proposals: Proposal[] = [];
  const expect = (entry: MemoryEntry) => ({ text: entry.text, trust: entry.trust });
  const groups = new Map<string, MemoryEntry[]>();
  // Turn records are episodes, not facts: they are never deduped, retracted, promoted or synced.
  for (const entry of local.filter((item) => !isTurn(item.source))) {
    const key = JSON.stringify([entry.subject, entry.subject_id, norm(entry.text)]);
    groups.set(key, [...groups.get(key) ?? [], entry]);
  }
  const remoteTexts = new Set(remote.map((entry) => norm(entry.text)));
  const localTexts = new Set(local.map((entry) => norm(entry.text)));
  for (const group of groups.values()) {
    // Keep the most trusted, then the oldest, copy; the rest are duplicates.
    const [keep, ...duplicates] = [...group].sort((a, b) => rank[b.trust] - rank[a.trust] || a.created_at - b.created_at);
    for (const entry of duplicates) {
      proposals.push({ kind: 'dedupe', target: entry.id, text: clip(entry.text), destructive: true, expect: expect(entry),
        reason: `Duplicate of ${keep!.id} (${keep!.trust})` });
    }
    if (keep!.trust === 'untrusted' && now - keep!.created_at > STALE_CANDIDATE_MS && !remoteTexts.has(norm(keep!.text))) {
      proposals.push({ kind: 'retract', target: keep!.id, text: clip(keep!.text), destructive: true, expect: expect(keep!),
        reason: 'Untrusted candidate never corroborated in 30 days' });
      continue;
    }
    const corroborated = group.length > 1 || remoteTexts.has(norm(keep!.text));
    if (keep!.trust === 'observed' && corroborated) {
      proposals.push({ kind: 'promote', target: keep!.id, text: clip(keep!.text), destructive: false, expect: expect(keep!),
        reason: group.length > 1 ? `Observed ${group.length} times in L1` : 'Corroborated by Honcho (L2)' });
    }
    if (l2Ready && keep!.trust === 'confirmed' && !remoteTexts.has(norm(keep!.text))) {
      proposals.push({ kind: 'sync-l2', target: keep!.id, text: clip(keep!.text), destructive: false, expect: expect(keep!),
        reason: 'Confirmed L1 fact missing from Honcho' });
    }
  }
  if (l2Ready) {
    const copied = new Set<string>();
    for (const entry of remote) {
      const key = norm(entry.text);
      if (isTurn(entry.source) || localTexts.has(key) || copied.has(key)) continue;
      copied.add(key);
      // L2 facts enter L1 as observed at most: crossing layers never raises trust.
      proposals.push({ kind: 'sync-l1', target: entry.id, text: entry.text, destructive: false,
        reason: 'Honcho fact missing from L1', copy: { subject: entry.subject, subjectId: entry.subject_id,
          source: entry.source, provenance: `honcho:${entry.id}; ${entry.provenance}`,
          trust: entry.trust === 'confirmed' ? 'observed' : entry.trust } });
    }
  }
  return proposals;
}

function describe(proposal: Proposal) { return `${proposal.kind}: ${clip(proposal.text)} (${proposal.reason})`; }

function summary(report: Report) {
  const count = (kind: Proposal['kind']) => report.proposals.filter((item) => item.kind === kind).length;
  const parts = [`${count('dedupe')} dedupe`, `${count('retract')} retract`, `${count('promote')} promote`,
    `${count('sync-l2')} L1->L2`, `${count('sync-l1')} L2->L1`];
  return report.status === 'applied'
    ? `Memory dream applied ${report.applied} of ${report.proposals.length} changes (${parts.join(', ')}).`
    : `Memory dream proposes ${report.proposals.length} changes (${parts.join(', ')}). Review before they are written.`;
}

function render(report: Report) {
  const lines = [`# Dream report ${new Date(report.createdAt).toISOString()}`, '',
    `Workspace: ${report.workspace}`, `Status: ${report.status}${report.acceptMode ? ` (accept mode ${report.acceptMode})` : ''}`, ''];
  if (!report.proposals.length) lines.push('Nothing to consolidate.');
  for (const proposal of report.proposals) {
    lines.push(`- **${proposal.kind}**${proposal.destructive ? ' (destructive)' : ''}: ${clip(proposal.text)}`,
      `  - ${proposal.reason}; target ${proposal.target}`);
  }
  if (report.risks.length) lines.push('', '## Risks', ...report.risks.map((risk) => `- ${risk}`));
  return lines.join('\n') + '\n';
}

function publicReport({ fingerprint: _fingerprint, ...report }: Report): DreamReport {
  return { ...report, proposals: report.proposals.map(({ kind, target, text, reason, destructive }) =>
    ({ kind, target, text, reason, destructive })) };
}

function atomicWrite(file: string, content: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
