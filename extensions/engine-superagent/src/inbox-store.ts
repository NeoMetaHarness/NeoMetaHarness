import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inboxItemSchema, type InboxItem } from '@neometaharness/contracts';

/** Neo-owned records only; upstream's in-memory tickets are never patched or serialized. */
export class InboxStore {
  constructor(private readonly filename: string) {}
  load(): InboxItem[] {
    if (!existsSync(this.filename)) return [];
    const records = inboxItemSchema.array().parse(JSON.parse(readFileSync(this.filename, 'utf8')));
    // Upstream bump Suggestions hold no in-memory Eval (accepting one starts a new ticket), so they survive.
    const resumable = (item: InboxItem) => item.status === 'suggestion' && item.source === 'neo/upstream';
    return records.map(item => item.status === 'running' || (item.status === 'suggestion' && !resumable(item)) ? {
      ...item, status: 'blocked' as const, updatedAt: Date.now(), report: {
        status: 'blocked' as const, summary: 'Engine restarted; submit a new request to continue this item.',
        changes: [], tests: [], risks: ['Upstream tickets are held in memory and cannot resume after restart.'], options: [],
      },
    } : item);
  }
  save(items: InboxItem[]): void {
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(items), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.filename);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
}
