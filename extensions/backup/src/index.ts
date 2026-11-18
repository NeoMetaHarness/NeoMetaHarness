import { defineExtension } from '@neometaharness/kernel';
import { createBackup, type BackupSource } from './archive.js';

export default defineExtension({
  activate(ctx) {
    const source = ctx.inject<BackupSource>('backupSource');
    if (!source) throw new Error('Backup storage service unavailable');
    ctx.route('backup', ({ body }) => createBackup(source, body as { out: string; passphrase: string }));
    ctx.health(() => ({ ok: true }));
  },
});
