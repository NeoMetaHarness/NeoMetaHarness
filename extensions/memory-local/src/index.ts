import { defineExtension } from '@neometaharness/kernel';
import type { MemoryStore, MemoryDraft, MemoryQuery } from '@neometaharness/db';

/** Standing intents are L1 entries with this source: durable, user-stated goals or preferences. */
export const INTENT_SOURCE = 'neo.intent';
const reserved = (source: unknown) => source === INTENT_SOURCE;

export default defineExtension({
  activate(ctx) {
    const memory = ctx.inject<MemoryStore>('memoryRecords');
    if (!memory?.get) throw new Error('Neo memory database service unavailable');
    const get = memory.get.bind(memory);
    ctx.provide('memoryStore', memory);
    ctx.health(() => ({ ok: true }));
    ctx.route('list', ({ body }) => memory.list(body as MemoryQuery));
    // The intent source is reserved for the intents routes, so a plain write can never steer engines.
    ctx.route('add', ({ body }) => {
      const draft = body as MemoryDraft;
      if (reserved(draft.source)) throw new Error('Standing intents are added through the intents routes');
      return memory.add(draft);
    });
    // In server mode the Gateway names the caller's workspace; an entry elsewhere is treated as missing.
    const foreign = (entry: { workspace: string } | undefined, workspace?: string) =>
      !entry || (workspace !== undefined && entry.workspace !== workspace);
    ctx.route('update', async ({ body }) => {
      const { id, workspace, editedBy, ...changes } = body as { id: string; workspace?: string; editedBy?: string }
        & Parameters<MemoryStore['update']>[1];
      const current = await get(id);
      if (foreign(current, workspace)) return undefined;
      if (reserved(current!.source) || reserved(changes.source)) throw new Error('Standing intents change only through the intents routes');
      // The Gateway names the editor; the entry keeps its origin and gains who changed it.
      if (editedBy) changes.provenance = `${current!.provenance}; edited via ${editedBy}`;
      return memory.update(id, changes);
    });
    ctx.route('delete', async ({ body }) => {
      const { id, workspace } = body as { id: string; workspace?: string };
      const current = await get(id);
      if (foreign(current, workspace)) return { deleted: false };
      if (reserved(current!.source)) throw new Error('Standing intents are retracted through the intents routes');
      return { deleted: await memory.delete(id) };
    });
    ctx.route('export', ({ body }) => memory.export((body as { workspace: string }).workspace));

    const intents = (workspace: string) => memory.list({ workspace, source: INTENT_SOURCE, limit: 500 });
    ctx.route('intents/list', ({ body }) => intents((body as { workspace: string }).workspace));
    // The Gateway supplies provenance from the authenticated user; a user-stated intent is confirmed.
    ctx.route('intents/add', ({ body }) => {
      const value = body as { workspace: string; text: string; provenance: string };
      return memory.add({ workspace: value.workspace, subject: 'user', subjectId: 'global', text: value.text,
        source: INTENT_SOURCE, provenance: value.provenance, trust: 'confirmed' });
    });
    ctx.route('intents/update', async ({ body }) => {
      const value = body as { workspace: string; id: string; text: string; editedBy: string };
      const current = await get(value.id);
      if (foreign(current, value.workspace) || !reserved(current!.source)) return { entry: null };
      const entry = await memory.update(value.id, {
        text: value.text, provenance: `${current!.provenance}; edited via ${value.editedBy}`,
      });
      return { entry: entry ?? null, previousText: current!.text };
    });
    // Only an intent in the caller's workspace can be retracted. The text is returned so the Gateway can
    // also forget any Honcho copy.
    ctx.route('intents/retract', async ({ body }) => {
      const value = body as { workspace: string; id: string };
      const current = await get(value.id);
      if (!current || current.workspace !== value.workspace || !reserved(current.source)) return { retracted: false };
      return { retracted: await memory.delete(value.id), text: current.text };
    });
  },
});
