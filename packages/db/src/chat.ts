import type { DatabaseSync } from 'node:sqlite';

export type ChatBinding = {
  id: string;
  engine: 'hermes' | 't3';
  workspace_id: string;
  profile: string | null;
  last_run: string | null;
};
export type ChatRunBinding = ChatBinding & { sender_id: string; interactive: number };

export class ChatRecords {
  constructor(private readonly sqlite: DatabaseSync) {}

  migrate() {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS chat_binding (
        id TEXT PRIMARY KEY,
        engine TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        profile TEXT,
        last_run TEXT
      );
      CREATE TABLE IF NOT EXISTS chat_run (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES chat_binding(id),
        sender_id TEXT NOT NULL,
        interactive INTEGER NOT NULL
      );
    `);
  }

  create(id: string, engine: ChatBinding['engine'], workspaceId: string, profile?: string) {
    this.sqlite.prepare('INSERT INTO chat_binding (id, engine, workspace_id, profile) VALUES (?, ?, ?, ?)')
      .run(id, engine, workspaceId, profile ?? null);
  }

  get(id: string): ChatBinding | undefined {
    return this.sqlite.prepare('SELECT * FROM chat_binding WHERE id = ?').get(id) as ChatBinding | undefined;
  }

  forRun(runId: string): ChatRunBinding | undefined {
    return this.sqlite.prepare('SELECT b.*, r.sender_id, r.interactive FROM chat_binding b JOIN chat_run r ON r.conversation_id = b.id WHERE r.id = ?')
      .get(runId) as ChatRunBinding | undefined;
  }

  recordRun(conversationId: string, runId: string, senderId: string, interactive: boolean) {
    this.sqlite.exec('BEGIN');
    try {
      this.sqlite.prepare('INSERT INTO chat_run (id, conversation_id, sender_id, interactive) VALUES (?, ?, ?, ?)')
        .run(runId, conversationId, senderId, Number(interactive));
      this.sqlite.prepare('UPDATE chat_binding SET last_run = ? WHERE id = ?').run(runId, conversationId);
      this.sqlite.exec('COMMIT');
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}
