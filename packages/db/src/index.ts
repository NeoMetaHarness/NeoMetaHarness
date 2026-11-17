import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Kysely, SqliteDialect } from 'kysely';

interface ExtensionStateTable {
  id: string;
  enabled: number;
}

interface NeoTables {
  extension_state: ExtensionStateTable;
}

/** Data persists when an extension is disabled. The provider owns the connection. */
export interface DatabaseProvider {
  migrate(): Promise<void>;
  getEnabled(id: string): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  close(): Promise<void>;
}

export class SqliteDatabaseProvider implements DatabaseProvider {
  private readonly db: Kysely<NeoTables>;

  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    const sqlite = new DatabaseSync(filename);
    this.db = new Kysely<NeoTables>({
      dialect: new SqliteDialect({
        database: {
          prepare(sql) {
            const statement = sqlite.prepare(sql);
            return {
              reader: statement.columns().length > 0,
              run: (parameters) => statement.run(...parameters as SQLInputValue[]),
              all: (parameters) => statement.all(...parameters as SQLInputValue[]),
              iterate: (parameters) => statement.iterate(...parameters as SQLInputValue[]),
            };
          },
          close() { sqlite.close(); },
        },
      }),
    });
  }

  async migrate(): Promise<void> {
    await this.db.schema.createTable('extension_state').ifNotExists()
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('enabled', 'integer', (column) => column.notNull())
      .execute();
  }

  async getEnabled(id: string): Promise<boolean> {
    const row = await this.db.selectFrom('extension_state')
      .select('enabled').where('id', '=', id).executeTakeFirst();
    return row?.enabled === 1;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const value = enabled ? 1 : 0;
    await this.db.insertInto('extension_state').values({ id, enabled: value })
      .onConflict((conflict) => conflict.column('id').doUpdateSet({ enabled: value })).execute();
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }
}
