import type { Kysely, Generated } from 'kysely';
import type { NeoTables } from './index.js';

export type TurnStatus = 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'denied' | 'stopped' | 'failed' | 'interrupted';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'interrupted';

export interface AgentBot { id: string; name: string; created_at: number }
export interface AgentRoom { id: string; name: string; created_at: number }
export interface AgentRoomMember { room_id: string; bot_id: string }
export interface AgentRoomMessage { id: string; room_id: string; author_id: string; body: string; created_at: number }
export interface AgentTurn {
  id: string; bot_id: string; room_id: string | null; source: 'user' | 'room' | 'bot' | 'routine';
  input: string; status: TurnStatus; created_at: number; updated_at: number;
}
export interface AgentEvent {
  seq: Generated<number>; turn_id: string; kind: string; payload: string; created_at: number;
}
export interface AgentApproval {
  id: string; turn_id: string; request_id: string; tool: string; detail: string;
  status: ApprovalStatus; created_at: number; resolved_at: number | null;
}
export interface AgentTask {
  id: string; bot_id: string; title: string; status: 'todo' | 'working' | 'done';
  note: string; created_at: number; updated_at: number;
}
export interface AgentRoutine {
  id: string; bot_id: string; name: string; prompt: string; schedule: string;
  timezone: string; enabled: number; last_run_at: number | null; created_at: number;
}
export interface AgentTables {
  agent_bot: AgentBot;
  agent_room: AgentRoom;
  agent_room_member: AgentRoomMember;
  agent_room_message: AgentRoomMessage;
  agent_turn: AgentTurn;
  agent_event: AgentEvent;
  agent_approval: AgentApproval;
  agent_task: AgentTask;
  agent_routine: AgentRoutine;
}

/** The agent domain uses the same Kysely connection and migration lifecycle as Neo. */
export class AgentRecords {
  constructor(private readonly db: Kysely<NeoTables>) {}

  async migrate(): Promise<void> {
    await this.db.schema.createTable('agent_bot').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('created_at', 'integer', (c) => c.notNull()).execute();
    await this.db.schema.createTable('agent_room').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('created_at', 'integer', (c) => c.notNull()).execute();
    await this.db.schema.createTable('agent_room_member').ifNotExists()
      .addColumn('room_id', 'text', (c) => c.notNull().references('agent_room.id'))
      .addColumn('bot_id', 'text', (c) => c.notNull().references('agent_bot.id'))
      .addPrimaryKeyConstraint('agent_room_member_pk', ['room_id', 'bot_id']).execute();
    await this.db.schema.createTable('agent_room_message').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('room_id', 'text', (c) => c.notNull().references('agent_room.id'))
      .addColumn('author_id', 'text', (c) => c.notNull())
      .addColumn('body', 'text', (c) => c.notNull())
      .addColumn('created_at', 'integer', (c) => c.notNull()).execute();
    await this.db.schema.createTable('agent_turn').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('bot_id', 'text', (c) => c.notNull().references('agent_bot.id'))
      .addColumn('room_id', 'text')
      .addColumn('source', 'text', (c) => c.notNull())
      .addColumn('input', 'text', (c) => c.notNull())
      .addColumn('status', 'text', (c) => c.notNull())
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .addColumn('updated_at', 'integer', (c) => c.notNull()).execute();
    await this.db.schema.createTable('agent_event').ifNotExists()
      .addColumn('seq', 'integer', (c) => c.primaryKey().autoIncrement())
      .addColumn('turn_id', 'text', (c) => c.notNull().references('agent_turn.id'))
      .addColumn('kind', 'text', (c) => c.notNull())
      .addColumn('payload', 'text', (c) => c.notNull())
      .addColumn('created_at', 'integer', (c) => c.notNull()).execute();
    await this.db.schema.createTable('agent_approval').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('turn_id', 'text', (c) => c.notNull().references('agent_turn.id'))
      .addColumn('request_id', 'text', (c) => c.notNull())
      .addColumn('tool', 'text', (c) => c.notNull())
      .addColumn('detail', 'text', (c) => c.notNull())
      .addColumn('status', 'text', (c) => c.notNull())
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .addColumn('resolved_at', 'integer').execute();
    await this.db.schema.createTable('agent_task').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('bot_id', 'text', (c) => c.notNull().references('agent_bot.id'))
      .addColumn('title', 'text', (c) => c.notNull())
      .addColumn('status', 'text', (c) => c.notNull())
      .addColumn('note', 'text', (c) => c.notNull())
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .addColumn('updated_at', 'integer', (c) => c.notNull()).execute();
    await this.db.schema.createTable('agent_routine').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('bot_id', 'text', (c) => c.notNull().references('agent_bot.id'))
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('prompt', 'text', (c) => c.notNull())
      .addColumn('schedule', 'text', (c) => c.notNull())
      .addColumn('timezone', 'text', (c) => c.notNull())
      .addColumn('enabled', 'integer', (c) => c.notNull())
      .addColumn('last_run_at', 'integer')
      .addColumn('created_at', 'integer', (c) => c.notNull()).execute();
  }

  /** A process restart cannot resume the previous process's in-memory run or approval waiter. */
  async interruptUnfinished(): Promise<void> {
    await this.db.updateTable('agent_turn').set({ status: 'interrupted', updated_at: Date.now() })
      .where('status', 'in', ['queued', 'running', 'awaiting_approval']).execute();
    await this.db.updateTable('agent_approval').set({ status: 'interrupted', resolved_at: Date.now() })
      .where('status', '=', 'pending').execute();
  }

  async createBot(bot: AgentBot): Promise<void> {
    await this.db.insertInto('agent_bot').values(bot).execute();
  }
  async getBot(id: string): Promise<AgentBot | undefined> {
    return this.db.selectFrom('agent_bot').selectAll().where('id', '=', id).executeTakeFirst();
  }
  async listBots(): Promise<AgentBot[]> {
    return this.db.selectFrom('agent_bot').selectAll().orderBy('created_at').execute();
  }
  async createRoom(room: AgentRoom, members: string[]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('agent_room').values(room).execute();
      if (members.length) await trx.insertInto('agent_room_member')
        .values(members.map((bot_id) => ({ room_id: room.id, bot_id }))).execute();
    });
  }
  async getRoom(id: string): Promise<AgentRoom | undefined> {
    return this.db.selectFrom('agent_room').selectAll().where('id', '=', id).executeTakeFirst();
  }
  async roomMembers(roomId: string): Promise<AgentBot[]> {
    return this.db.selectFrom('agent_room_member').innerJoin('agent_bot', 'agent_bot.id', 'agent_room_member.bot_id')
      .select(['agent_bot.id', 'agent_bot.name', 'agent_bot.created_at'])
      .where('agent_room_member.room_id', '=', roomId).orderBy('agent_bot.created_at').execute();
  }
  async createRoomMessage(message: AgentRoomMessage): Promise<void> {
    await this.db.insertInto('agent_room_message').values(message).execute();
  }
  async roomMessages(roomId: string): Promise<AgentRoomMessage[]> {
    return this.db.selectFrom('agent_room_message').selectAll().where('room_id', '=', roomId)
      .orderBy('created_at').orderBy('id').execute();
  }
  async createTurn(turn: AgentTurn): Promise<void> {
    await this.db.insertInto('agent_turn').values(turn).execute();
  }
  async getTurn(id: string): Promise<AgentTurn | undefined> {
    return this.db.selectFrom('agent_turn').selectAll().where('id', '=', id).executeTakeFirst();
  }
  async listTurns(botId: string): Promise<AgentTurn[]> {
    return this.db.selectFrom('agent_turn').selectAll().where('bot_id', '=', botId)
      .orderBy('created_at').orderBy('id').execute();
  }
  async setTurnStatus(id: string, status: TurnStatus): Promise<void> {
    await this.db.updateTable('agent_turn').set({ status, updated_at: Date.now() })
      .where('id', '=', id).execute();
  }
  async setAwaitingApproval(id: string): Promise<boolean> {
    const result = await this.db.updateTable('agent_turn')
      .set({ status: 'awaiting_approval', updated_at: Date.now() })
      .where('id', '=', id).where('status', '=', 'running').executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }
  async resumeApprovedTurn(id: string): Promise<boolean> {
    const result = await this.db.updateTable('agent_turn')
      .set({ status: 'running', updated_at: Date.now() })
      .where('id', '=', id).where('status', '=', 'awaiting_approval').executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }
  async appendEvent(turnId: string, kind: string, payload: string): Promise<void> {
    await this.db.insertInto('agent_event').values({ turn_id: turnId, kind, payload, created_at: Date.now() }).execute();
  }
  async turnEvents(turnId: string): Promise<Array<{ seq: number; kind: string; payload: string }>> {
    return this.db.selectFrom('agent_event').select(['seq', 'kind', 'payload'])
      .where('turn_id', '=', turnId).orderBy('seq').execute();
  }
  async createApproval(approval: AgentApproval): Promise<void> {
    await this.db.insertInto('agent_approval').values(approval).execute();
  }
  async getApproval(id: string): Promise<AgentApproval | undefined> {
    return this.db.selectFrom('agent_approval').selectAll().where('id', '=', id).executeTakeFirst();
  }
  async approvalsForTurn(turnId: string): Promise<AgentApproval[]> {
    return this.db.selectFrom('agent_approval').selectAll().where('turn_id', '=', turnId).execute();
  }
  async resolveApproval(id: string, status: 'approved' | 'denied'): Promise<boolean> {
    const result = await this.db.updateTable('agent_approval').set({ status, resolved_at: Date.now() })
      .where('id', '=', id).where('status', '=', 'pending').executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }
  async interruptApprovals(turnId: string): Promise<void> {
    await this.db.updateTable('agent_approval').set({ status: 'interrupted', resolved_at: Date.now() })
      .where('turn_id', '=', turnId).where('status', '=', 'pending').execute();
  }
  async createTask(task: AgentTask): Promise<void> {
    await this.db.insertInto('agent_task').values(task).execute();
  }
  async listTasks(botId: string): Promise<AgentTask[]> {
    return this.db.selectFrom('agent_task').selectAll().where('bot_id', '=', botId).orderBy('created_at').execute();
  }
  async updateTask(id: string, status: AgentTask['status'], note: string): Promise<boolean> {
    const result = await this.db.updateTable('agent_task').set({ status, note, updated_at: Date.now() })
      .where('id', '=', id).executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }
  async createRoutine(routine: AgentRoutine): Promise<void> {
    await this.db.insertInto('agent_routine').values(routine).execute();
  }
  async getRoutine(id: string): Promise<AgentRoutine | undefined> {
    return this.db.selectFrom('agent_routine').selectAll().where('id', '=', id).executeTakeFirst();
  }
  async listRoutines(): Promise<AgentRoutine[]> {
    return this.db.selectFrom('agent_routine').selectAll().orderBy('created_at').execute();
  }
  async setRoutineEnabled(id: string, enabled: boolean): Promise<void> {
    await this.db.updateTable('agent_routine').set({ enabled: enabled ? 1 : 0 }).where('id', '=', id).execute();
  }
  async touchRoutine(id: string): Promise<void> {
    await this.db.updateTable('agent_routine').set({ last_run_at: Date.now() }).where('id', '=', id).execute();
  }
}
