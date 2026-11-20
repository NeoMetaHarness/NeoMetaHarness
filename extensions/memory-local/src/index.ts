import { defineExtension } from '@neometaharness/kernel';
import type { MemoryStore, MemoryDraft, MemoryQuery } from '@neometaharness/db';

/** Standing intents are L1 entries with this source: durable, user-stated goals or preferences. */
export const INTENT_SOURCE = 'neo.intent';

export default defineExtension({
  activate(ctx) {
    const memory = ctx.inject<MemoryStore>('memoryRecords');
    if (!memory) throw new Error('Neo memory database service unavailable');
    ctx.provide('memoryStore', memory);
    ctx.health(() => ({ ok: true }));
    ctx.route('list', ({ body }) => memory.list(body as MemoryQuery));
    ctx.route('add', ({ body }) => memory.add(body as MemoryDraft));
    ctx.route('update', ({ body }) => {
      const { id, ...changes } = body as { id: string } & Parameters<MemoryStore['update']>[1];
      return memory.update(id, changes);
    });
    ctx.route('delete', async ({ body }) => ({ deleted: await memory.delete((body as { id: string }).id) }));
    ctx.route('export', ({ body }) => memory.export((body as { workspace: string }).workspace));

    const intents = (workspace: string) => memory.list({ workspace, source: INTENT_SOURCE, limit: 500 });
    ctx.route('intents/list', ({ body }) => intents((body as { workspace: string }).workspace));
    // The Gateway supplies provenance from the authenticated user; a user-stated intent is confirmed.
    ctx.route('intents/add', ({ body }) => {
      const value = body as { workspace: string; text: string; provenance: string };
      return memory.add({ workspace: value.workspace, subject: 'user', subjectId: 'global', text: value.text,
        source: INTENT_SOURCE, provenance: value.provenance, trust: 'confirmed' });
    });
    // Only an intent in the caller's workspace can be retracted through this route.
    ctx.route('intents/retract', async ({ body }) => {
      const value = body as { workspace: string; id: string };
      if (!(await intents(value.workspace)).some((entry) => entry.id === value.id)) return { retracted: false };
      return { retracted: await memory.delete(value.id) };
    });
  },
});
