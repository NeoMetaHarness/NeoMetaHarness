import { writeFile } from 'node:fs/promises';

// Pinned DSH 0.2.2-rc.1: packages/deliverables/workspace-changes/src/index.ts:145
// observes session/event, and packages/bundle/headless/tests/headless.spec.ts:231
// documents session/flush to drain pending writes before session/wait resolves.
export const name = 'neo-report';

export function apply(ctx) {
  const path = process.env.NEO_DSH_REPORT_PATH;
  if (!path) return;
  const pending = new Map();
  const writes = new Set();
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      pending.set(session, { turn: String(event.data.turn), user: '', assistant: '' });
      return;
    }
    const report = pending.get(session);
    if (!report) return;
    if (event.type === 'user/message' && event.data.source?.kind === 'user') {
      report.user = (event.data.content ?? []).filter((block) => block.type === 'text')
        .map((block) => block.text).join(' ').slice(0, 1000);
    } else if (event.type === 'assistant/message') {
      const text = (event.data.message?.content ?? []).filter((block) => block.type === 'text')
        .map((block) => block.text).join(' ').slice(0, 2000);
      if (text) report.assistant = text;
    } else if (event.type === 'turn/end') {
      pending.delete(session);
      const status = event.data.reason?.kind === 'completed' ? 'ready' : 'failed';
      const summary = report.assistant || `DSH turn ${status}`;
      const write = writeFile(path, JSON.stringify({ turn: report.turn, question: report.user,
        summary, status }), 'utf8').catch((error) =>
        ctx.logger.warn(`Neo DSH report write skipped: ${String(error)}`));
      writes.add(write);
      void write.finally(() => writes.delete(write));
    }
  });
  ctx.on('session/flush', async () => { await Promise.all([...writes]); });
  ctx.on('session/disposed', (session) => pending.delete(session));
}
