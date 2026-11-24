import type { Kysely } from 'kysely';
import type { NeoTables } from './index.js';

export type ChatBinding = {
  id: string;
  engine: 'hermes' | 't3';
  workspace_id: string;
  profile: string | null;
  last_run: string | null;
};
export type ChatRunBinding = ChatBinding & { sender_id: string; interactive: number };
export interface ChatTables {
  chat_binding: ChatBinding;
  chat_run: {
    id: string;
    conversation_id: string;
    sender_id: string;
    interactive: number;
  };
}

export class ChatRecords {
  constructor(private readonly db: Kysely<NeoTables>) {}

  async migrate() {
    await this.db.schema.createTable('chat_binding').ifNotExists()
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('engine', 'text', (column) => column.notNull())
      .addColumn('workspace_id', 'text', (column) => column.notNull())
      .addColumn('profile', 'text')
      .addColumn('last_run', 'text')
      .execute();
    await this.db.schema.createTable('chat_run').ifNotExists()
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('conversation_id', 'text', (column) => column.notNull().references('chat_binding.id'))
      .addColumn('sender_id', 'text', (column) => column.notNull())
      .addColumn('interactive', 'integer', (column) => column.notNull())
      .execute();
  }

  async create(id: string, engine: ChatBinding['engine'], workspaceId: string, profile?: string) {
    await this.db.insertInto('chat_binding').values({
      id, engine, workspace_id: workspaceId, profile: profile ?? null, last_run: null,
    }).execute();
  }

  get(id: string): Promise<ChatBinding | undefined> {
    return this.db.selectFrom('chat_binding').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async hiddenThreads(workspaceId?: string) {
    const query = this.db.selectFrom('chat_binding').select('id').where('engine', '=', 't3');
    const rows = await (workspaceId ? query.where('workspace_id', '!=', workspaceId) : query).execute();
    return new Set(rows.map(({ id }) => id));
  }

  forRun(runId: string): Promise<ChatRunBinding | undefined> {
    return this.db.selectFrom('chat_binding').innerJoin('chat_run', 'chat_run.conversation_id', 'chat_binding.id')
      .selectAll('chat_binding').select(['chat_run.sender_id', 'chat_run.interactive']).where('chat_run.id', '=', runId)
      .executeTakeFirst();
  }

  async recordRun(conversationId: string, runId: string, senderId: string, interactive: boolean) {
    await this.db.transaction().execute(async (transaction) => {
      await transaction.insertInto('chat_run').values({
        id: runId, conversation_id: conversationId, sender_id: senderId, interactive: Number(interactive),
      }).execute();
      await transaction.updateTable('chat_binding').set({ last_run: runId }).where('id', '=', conversationId).execute();
    });
  }
}
