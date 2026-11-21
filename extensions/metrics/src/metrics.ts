import { inboxItemSchema, type InboxItem } from '@neometaharness/contracts';

type Trace = { ticketId: string; trace_id: string; workspace?: string; chosenAction: string };
export type MetricsSources = {
  inbox: () => Promise<InboxItem[]> | InboxItem[];
  decisions: (workspace?: string) => Promise<Trace[]>;
  qualifiedSkills?: () => Promise<number>;
};

/** Read-only extension services supply current records. Missing event histories stay unavailable. */
export class SuccessMetrics {
  constructor(private readonly sources: MetricsSources) {}

  async summary({ workspace, onboardingCompletedAt }: {
    workspace?: string; onboardingCompletedAt?: string | null;
  } = {}) {
    const inbox = inboxItemSchema.array().parse(await this.sources.inbox());
    const scoped = (item: InboxItem) => workspace === undefined || item.workspace === workspace;
    const allTraces = await this.sources.decisions(workspace);
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

    // Registry assignments are deployment-wide and cannot be attributed to server workspaces.
    const qualifiedSkills = workspace === undefined && this.sources.qualifiedSkills
      ? await this.sources.qualifiedSkills() : null;

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
