import { defineExtension } from '@neometaharness/kernel';
import { createBackup, type BackupSource } from './archive.js';
import { restoreBackup } from './restore.js';

export default defineExtension({
  activate(ctx) {
    const source = ctx.inject<BackupSource>('backupSource');
    if (!source) throw new Error('Backup storage service unavailable');
    ctx.route('backup', ({ body }) => createBackup(source, body as { out: string; passphrase: string }));
    ctx.route('restore', ({ body }) => restoreBackup(body as Parameters<typeof restoreBackup>[0], ctx.inject<string[]>('backupProtectedPaths') ?? []));
    ctx.health(() => ({ ok: true }));
  },
});
