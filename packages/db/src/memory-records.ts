import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { NeoTables } from './index.js';

export type MemorySubject = 'user' | 'bot';
export type MemoryTrust = 'untrusted' | 'observed' | 'confirmed';

export interface MemoryEntry {
  id: string;
  workspace: string;
  subject: MemorySubject;
  subject_id: string;
  text: string;
  source: string;
  provenance: string;
  trust: MemoryTrust;
  created_at: number;
  updated_at: number;
}

export interface MemoryQuery { workspace: string; subjectId?: string; query?: string; limit?: number; source?: string }
export interface MemoryDraft {
  workspace: string; subject: MemorySubject; subjectId: string;
  text: string; source: string; provenance: string; trust: MemoryTrust;
}

/** Engine-neutral contract. Honcho can implement this interface independently. */
export interface MemoryStore {
  list(query: MemoryQuery): Promise<MemoryEntry[]>;
  add(draft: MemoryDraft): Promise<MemoryEntry>;
  /** One entry by id, whatever its age (optional: stores without random access omit it). */
  get?(id: string): Promise<MemoryEntry | undefined>;
  /** Every workspace that holds at least one entry (optional). */
  workspaces?(): Promise<string[]>;
  update(id: string, changes: Partial<Pick<MemoryDraft, 'text' | 'trust' | 'source' | 'provenance'>>): Promise<MemoryEntry | undefined>;
  delete(id: string): Promise<boolean>;
  export(workspace: string): Promise<Record<'SOUL.md' | 'USER.md' | 'MEMORY.md', string>>;
}

export class MemoryRecords implements MemoryStore {
  private fts = false;
  constructor(private readonly db: Kysely<NeoTables>) {}

  async migrate(): Promise<void> {
    await this.db.schema.createTable('memory_entry').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('workspace', 'text', (c) => c.notNull())
      .addColumn('subject', 'text', (c) => c.notNull())
      .addColumn('subject_id', 'text', (c) => c.notNull())
      .addColumn('text', 'text', (c) => c.notNull())
      .addColumn('source', 'text', (c) => c.notNull())
      .addColumn('provenance', 'text', (c) => c.notNull())
      .addColumn('trust', 'text', (c) => c.notNull())
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .addColumn('updated_at', 'integer', (c) => c.notNull()).execute();
    await this.db.schema.createIndex('memory_workspace_updated').ifNotExists()
      .on('memory_entry').columns(['workspace', 'updated_at']).execute();
    try {
      await sql`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(text, content='memory_entry', content_rowid='rowid')`.execute(this.db);
      await sql`CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory_entry BEGIN INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text); END`.execute(this.db);
      await sql`CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory_entry BEGIN INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END`.execute(this.db);
      await sql`CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON memory_entry BEGIN INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text); INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text); END`.execute(this.db);
      await sql`INSERT INTO memory_fts(memory_fts) VALUES ('rebuild')`.execute(this.db);
      this.fts = true;
    } catch {
      this.fts = false;
    }
  }

  async list({ workspace, subjectId, query = '', limit = 100, source }: MemoryQuery): Promise<MemoryEntry[]> {
    let statement = this.db.selectFrom('memory_entry').selectAll()
      .where('workspace', '=', workspace);
    if (source) statement = statement.where('source', '=', source);
    if (subjectId) statement = statement.where('subject_id', 'in', ['global', subjectId]);
    const search = query.trim();
    if (search) {
      if (this.fts) {
        // Quoting tokens prevents FTS query operators from escaping user text.
        const tokens = search.match(/[\p{L}\p{N}_]+/gu) ?? [];
        if (tokens.length) {
          statement = statement.where(sql<boolean>`rowid IN (SELECT rowid FROM memory_fts WHERE memory_fts MATCH ${tokens.map((token) => `"${token}"`).join(' OR ')})`);
        } else statement = statement.where('text', 'like', `%${search}%`);
      } else statement = statement.where('text', 'like', `%${search}%`);
    }
    return statement.orderBy('updated_at', 'desc').limit(Math.min(Math.max(limit, 1), 500)).execute();
  }

  async workspaces(): Promise<string[]> {
    const rows = await this.db.selectFrom('memory_entry').select('workspace').distinct().execute();
    return rows.map((row) => row.workspace).sort();
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    return this.db.selectFrom('memory_entry').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async add(draft: MemoryDraft): Promise<MemoryEntry> {
    const now = Date.now();
    const entry: MemoryEntry = {
      id: randomUUID(), workspace: draft.workspace, subject: draft.subject,
      subject_id: draft.subjectId, text: draft.text, source: draft.source,
      provenance: draft.provenance, trust: draft.trust, created_at: now, updated_at: now,
    };
    await this.db.insertInto('memory_entry').values(entry).execute();
    return entry;
  }

  async update(id: string, changes: Partial<Pick<MemoryDraft, 'text' | 'trust' | 'source' | 'provenance'>>): Promise<MemoryEntry | undefined> {
    await this.db.updateTable('memory_entry').set({ ...changes, updated_at: Date.now() })
      .where('id', '=', id).execute();
    return this.db.selectFrom('memory_entry').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom('memory_entry').where('id', '=', id).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async export(workspace: string): Promise<Record<'SOUL.md' | 'USER.md' | 'MEMORY.md', string>> {
    const records = await this.db.selectFrom('memory_entry').selectAll()
      .where('workspace', '=', workspace).orderBy('updated_at', 'desc').execute();
    const markdown = (title: string, items: MemoryEntry[]) => `# ${title}\n\n${items.map((entry) =>
      `- ${entry.text.replace(/\r?\n/g, '\n  ')}\n  - Source: ${entry.source} | ${entry.provenance} | Trust: ${entry.trust} | ${new Date(entry.created_at).toISOString()}`,
    ).join('\n') || '_No entries_'}\n`;
    return {
      'SOUL.md': markdown('Agent memory', records.filter((entry) => entry.subject === 'bot')),
      'USER.md': markdown('User memory', records.filter((entry) => entry.subject === 'user')),
      'MEMORY.md': markdown('All memory', records),
    };
  }
}
