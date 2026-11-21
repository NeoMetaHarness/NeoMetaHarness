import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { inboxItemSchema, type InboxItem } from '@neometaharness/contracts';

type Trace = { ticketId: string; trace_id: string; workspace?: string; chosenAction: string };
type Assignment = { name: string };
type Evaluation = { status: string };
type Skill = { name: string; version: number };

async function readJson(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function traces(root: string): Promise<Trace[]> {
  const dir = join(root, 'engine-superagent', 'traces');
  const files = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  const entries = files.filter((name) => /^decisions\.jsonl(?:\.[1-3])?$/.test(name));
  const lines = await Promise.all(entries.map((name) => readFile(join(dir, name), 'utf8')));
  return lines.flatMap((file) => file.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Trace));
}

/** Existing local records are used directly. Incomplete event histories stay explicitly unavailable. */
export class SuccessMetrics {
  constructor(private readonly root: string) {}

  async summary({ workspace, onboardingCompletedAt }: {
    workspace?: string; onboardingCompletedAt?: string | null;
  } = {}) {
    const inbox = inboxItemSchema.array().parse(
      (await readJson(join(this.root, 'engine-superagent', 'inbox.json'))) ?? [],
    );
    const scoped = (item: InboxItem) => workspace === undefined || item.workspace === workspace;
    const allTraces = await traces(this.root);
    const completions = new Set(allTraces.filter((entry) => entry.chosenAction === 'ticket.complete'
      && (workspace === undefined || entry.workspace === workspace)).map((entry) => entry.ticketId));
    const finished = inbox.filter((item) => scoped(item)
      && ['ready', 'blocked'].includes(item.status)
      && (item.episode?.traceId || completions.has(item.id)));
    const completedTickets = finished.filter((item) => item.status === 'ready').length;
    const withRecordedApproval = finished.filter((item) => !!item.approval?.decision).length;
    const delivered = inbox.filter((item) => scoped(item) && item.source === 'neo/channel'
      && item.notification?.deliveredAt !== undefined)
      .map((item) => item.notification!.deliveredAt!).sort((a, b) => a - b);
    const onboarding = onboardingCompletedAt ? Date.parse(onboardingCompletedAt) : NaN;
    const onboardingToFirstReplyMinutes = workspace === undefined && Number.isFinite(onboarding)
      ? (delivered.find((at) => at >= onboarding) ?? null) : null;

    // The registry is deployment-wide. In server mode its records cannot be assigned to a workspace.
    let qualifiedSkills: number | null = null;
    if (workspace === undefined) {
      const assignments = ((await readJson(join(this.root, 'skills-registry', 'assignments.json'))) ?? []) as Assignment[];
      const evaluations = ((await readJson(join(this.root, 'skills-registry', 'evaluations.json'))) ?? {}) as Record<string, Evaluation>;
      const assigned = new Set(assignments.map((entry) => entry.name));
      const repo = join(this.root, 'skills-registry', 'repo', 'skills');
      const owners = await readdir(repo).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [] as string[];
        throw error;
      });
      const records = await Promise.all(owners.map(async (owner) => {
        const names = await readdir(join(repo, owner), { withFileTypes: true });
        return Promise.all(names.filter((entry) => entry.isDirectory()).map(async (entry) =>
          readJson(join(repo, owner, entry.name, 'metadata.json')) as Promise<Skill | undefined>));
      }));
      qualifiedSkills = records.flat().filter((skill): skill is Skill => !!skill)
        .filter((skill) => assigned.has(skill.name)
          && ['passed', 'overridden'].includes(evaluations[`${skill.name}@${skill.version}`]?.status ?? '')).length;
    }

    return {
      completedTickets,
      finishedTickets: finished.length,
      attention: {
        share: null,
        observedWithoutFinalApprovalShare: finished.length
          ? (finished.length - withRecordedApproval) / finished.length : null,
        withRecordedApproval,
        reason: 'Only the latest approval is stored. Human question replies and repeated approvals have no durable event history.',
      },
      learning: {
        promotedPer20: null,
        rollbackRate: null,
        qualifiedSkills,
        reason: workspace === undefined
          ? 'The registry records current evaluated assignments, but no promotion or rollback events over time.'
          : 'Skill records lack workspace ownership, promotion history and rollback events.',
      },
      firstValue: {
        minutes: null,
        onboardingToFirstReplyMinutes: onboardingToFirstReplyMinutes === null
          ? null : (onboardingToFirstReplyMinutes - onboarding) / 60_000,
        reason: 'Install time and all channel first-answer events are not persisted. Onboarding to Inbox channel delivery is a partial proxy.',
      },
    };
  }
}
