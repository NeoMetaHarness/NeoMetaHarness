import { defineExtension } from '@neometaharness/kernel';
import type { VaultService } from '@neometaharness/vault';
import type { MemoryQuery, MemoryDraft, MemoryStore } from '@neometaharness/db';
import { HonchoStore } from './store.js';

export default defineExtension({
  activate(ctx) {
    const vault = ctx.inject<VaultService>('vault');
    if (!vault) throw new Error('Honcho requires the vault service');
    const store: MemoryStore & HonchoStore = new HonchoStore(vault);
    ctx.provide('honchoMemoryStore', store);
    ctx.health(async () => ({ ok: (await store.status('default')) !== 'degraded' }));
    ctx.route('status', ({ body }) => store.status((body as { workspace: string }).workspace));
    ctx.route('list', ({ body }) => store.list(body as MemoryQuery));
    ctx.route('add', ({ body }) => store.add(body as MemoryDraft));
    ctx.route('update', ({ body }) => {
      const { id, ...changes } = body as { id: string } & Parameters<MemoryStore['update']>[1];
      return store.update(id, changes);
    });
    ctx.route('delete', async ({ body }) => ({ deleted: await store.delete((body as { id: string }).id) }));
    ctx.route('export', ({ body }) => store.export((body as { workspace: string }).workspace));
    ctx.route('context', ({ body }) => {
      const value = body as { workspace: string; subjectId: string };
      return store.context(value.workspace, value.subjectId);
    });
    ctx.route('turn', ({ body }) => store.writeTurn(body as {
      workspace: string; subjectId: string; user: string; assistant: string; session: string;
    }));
    ctx.route('chat', ({ body }) => {
      const value = body as { workspace: string; subjectId: string; query: string };
      return store.chat(value.workspace, value.subjectId, value.query);
    });
  },
});
