import { defineExtension } from '@neometaharness/kernel';
import type { MemoryStore, MemoryDraft, MemoryQuery } from '@neometaharness/db';

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
  },
});
