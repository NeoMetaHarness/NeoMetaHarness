import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Kysely, SqliteDialect } from 'kysely';

interface ExtensionStateTable {
  id: string;
  enabled: number;
}

export type VaultScopeKind = 'workspace' | 'bot' | 'engine';

export interface VaultStoredSecret {
  id: string;
  scopeKind: VaultScopeKind;
  workspaceId: string;
  subjectId: string;
  name: string;
  iv: string;
  tag: string;
  ciphertext: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

interface VaultSecretTable {
  id: string;
  scope_kind: VaultScopeKind;
  workspace_id: string;
  subject_id: string;
  name: string;
  iv: string;
  tag: string;
  ciphertext: string;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface VaultRecordStore {
  getVaultSecret(id: string): Promise<VaultStoredSecret | undefined>;
  listVaultSecrets(scopeKind: VaultScopeKind, workspaceId: string, subjectId: string): Promise<VaultStoredSecret[]>;
  writeVaultSecret(record: VaultStoredSecret, previousVersion: number | null): Promise<boolean>;
  deleteVaultSecret(id: string): Promise<boolean>;
}

function fromVaultRow(row: VaultSecretTable): VaultStoredSecret {
  return {
    id: row.id, scopeKind: row.scope_kind, workspaceId: row.workspace_id,
    subjectId: row.subject_id, name: row.name, iv: row.iv, tag: row.tag,
    ciphertext: row.ciphertext, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function toVaultRow(record: VaultStoredSecret): VaultSecretTable {
  return {
    id: record.id, scope_kind: record.scopeKind, workspace_id: record.workspaceId,
    subject_id: record.subjectId, name: record.name, iv: record.iv, tag: record.tag,
    ciphertext: record.ciphertext, version: record.version,
    created_at: record.createdAt, updated_at: record.updatedAt,
  };
}
interface NeoTables {
  extension_state: ExtensionStateTable;
  vault_secret: VaultSecretTable;
}

/** Data persists when an extension is disabled. The provider owns the connection. */
export interface DatabaseProvider {
  migrate(): Promise<void>;
  getEnabled(id: string): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  close(): Promise<void>;
}

export class SqliteDatabaseProvider implements DatabaseProvider, VaultRecordStore {
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
    await this.db.schema.createTable('vault_secret').ifNotExists()
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('scope_kind', 'text', (column) => column.notNull())
      .addColumn('workspace_id', 'text', (column) => column.notNull())
      .addColumn('subject_id', 'text', (column) => column.notNull())
      .addColumn('name', 'text', (column) => column.notNull())
      .addColumn('iv', 'text', (column) => column.notNull())
      .addColumn('tag', 'text', (column) => column.notNull())
      .addColumn('ciphertext', 'text', (column) => column.notNull())
      .addColumn('version', 'integer', (column) => column.notNull())
      .addColumn('created_at', 'integer', (column) => column.notNull())
      .addColumn('updated_at', 'integer', (column) => column.notNull())
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

  async getVaultSecret(id: string): Promise<VaultStoredSecret | undefined> {
    const row = await this.db.selectFrom('vault_secret')
      .selectAll().where('id', '=', id).executeTakeFirst();
    return row ? fromVaultRow(row) : undefined;
  }

  async listVaultSecrets(scopeKind: VaultScopeKind, workspaceId: string, subjectId: string): Promise<VaultStoredSecret[]> {
    const rows = await this.db.selectFrom('vault_secret').selectAll()
      .where('scope_kind', '=', scopeKind)
      .where('workspace_id', '=', workspaceId)
      .where('subject_id', '=', subjectId)
      .orderBy('name').execute();
    return rows.map(fromVaultRow);
  }

  async writeVaultSecret(record: VaultStoredSecret, previousVersion: number | null): Promise<boolean> {
    const row = toVaultRow(record);
    if (previousVersion === null) {
      const result = await this.db.insertInto('vault_secret').values(row)
        .onConflict((conflict) => conflict.column('id').doNothing()).executeTakeFirst();
      return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
    }
    const { id: _id, ...fields } = row;
    const result = await this.db.updateTable('vault_secret').set(fields)
      .where('id', '=', row.id).where('version', '=', previousVersion).executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async deleteVaultSecret(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom('vault_secret').where('id', '=', id).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }
  async close(): Promise<void> {
    await this.db.destroy();
  }
}
