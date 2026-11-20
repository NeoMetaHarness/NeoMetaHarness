import type { InboxItem } from '@neometaharness/contracts';

export type DshReport = { sessionId: string; workspaceId: string; profile: string;
  turn: string; status: 'ready' | 'failed'; summary: string; question: string };

/** The Inbox item for a DSH turn report. It belongs to the DSH session's workspace (P6-10). */
export function dshReportItem(input: DshReport, id: string, now: number): InboxItem {
  return { id, botId: input.profile, source: 'neo/dsh', workspace: input.workspaceId,
    requesterRole: 'member', mode: 'observe', status: input.status,
    text: input.question.slice(0, 1000) || `DSH ${input.profile} session ${input.sessionId}`,
    report: { status: input.status, summary: input.summary.slice(0, 2000), changes: [], tests: [], risks: [], options: [] },
    createdAt: now, updatedAt: now };
}
