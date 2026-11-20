import { join } from 'node:path';
import { defineExtension } from '@neometaharness/kernel';
import type { VaultService } from '@neometaharness/vault';
import type { MemoryQuery, MemoryDraft, MemoryStore } from '@neometaharness/db';
import { HonchoStore } from './store.js';
import { Dreamer, type MemoryInboxSink } from './dream.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export default defineExtension({
  activate(ctx) {
    const vault = ctx.inject<VaultService>('vault');
    const dataDir = ctx.inject<string>('extensionDataDir');
    if (!vault) throw new Error('Honcho requires the vault service');
    if (!dataDir) throw new Error('Honcho dreaming requires isolated extension storage');
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

    // Dreaming reads L1 through memory-local's `memoryStore` and L2 through Honcho's REST seam. Both
    // that store and the Inbox sink are looked up per pass, so either extension can be toggled freely.
    const dreamer = new Dreamer(join(dataDir, 'memory-honcho', 'dreams'), store,
      () => ctx.inject<MemoryStore>('memoryStore'), () => ctx.inject<MemoryInboxSink>('memoryInboxSink'));
    ctx.provide('memoryDreams', { apply: (id: string) => dreamer.apply(id), reject: (id: string) => dreamer.reject(id) });
    ctx.route('dream/run', ({ body }) => dreamer.run((body as { workspace: string }).workspace));
    ctx.route('dream/last', ({ body }) => dreamer.last((body as { workspace: string }).workspace));

    // Nightly pass over the desktop workspace. Other workspaces dream on demand (`dream/run`).
    const interval = process.env.NODE_ENV === 'test' && process.env.NMH_HONCHO_DREAM_INTERVAL_MS
      ? Math.max(200, Number(process.env.NMH_HONCHO_DREAM_INTERVAL_MS)) : DAY_MS;
    const timer = setInterval(() => {
      void dreamer.run('default').catch((error) => console.error('Memory dream failed:', error instanceof Error ? error.message : error));
    }, interval);
    timer.unref();
    ctx.effect(() => () => { clearInterval(timer); dreamer.close(); });
  },
});
