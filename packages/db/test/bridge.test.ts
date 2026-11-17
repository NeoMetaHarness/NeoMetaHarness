import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { sql } from 'kysely';
import {
  createNodeSqliteDatabase,
  createNodeSqliteDialect,
  createNodeSqliteKysely,
  SqliteDatabaseProvider,
} from '../src/index.js';

interface TestUser {
  id: string;
  name: string;
  email: string;
}

interface TestDatabase {
  users: TestUser;
}

test('node:sqlite bridge detects reader vs writer statements via columns()', () => {
  const sqlite = new DatabaseSync(':memory:');
  const db = createNodeSqliteDatabase(sqlite);

  sqlite.exec('CREATE TABLE test_reader (id TEXT PRIMARY KEY, val TEXT);');

  const insertStmt = db.prepare('INSERT INTO test_reader (id, val) VALUES (?, ?)');
  assert.equal(insertStmt.reader, false, 'INSERT without RETURNING must have reader=false');

  const insertReturningStmt = db.prepare('INSERT INTO test_reader (id, val) VALUES (?, ?) RETURNING id, val');
  assert.equal(insertReturningStmt.reader, true, 'INSERT with RETURNING must have reader=true');

  const selectStmt = db.prepare('SELECT id, val FROM test_reader');
  assert.equal(selectStmt.reader, true, 'SELECT must have reader=true');

  const pragmaStmt = db.prepare('PRAGMA table_info(test_reader)');
  assert.equal(pragmaStmt.reader, true, 'PRAGMA table_info must have reader=true');

  const deleteStmt = db.prepare('DELETE FROM test_reader WHERE id = ?');
  assert.equal(deleteStmt.reader, false, 'DELETE must have reader=false');

  db.close();
});

test('Kysely over node:sqlite dialect supports CRUD, CTEs, and transactions', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const db = createNodeSqliteKysely<TestDatabase>(sqlite);

  await db.schema.createTable('users')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('email', 'text', (col) => col.notNull())
    .execute();

  // Insert
  await db.insertInto('users').values({
    id: 'u-1',
    name: 'Alice',
    email: 'alice@example.com',
  }).execute();

  // Select
  const user = await db.selectFrom('users').selectAll().where('id', '=', 'u-1').executeTakeFirst();
  assert.equal(user?.name, 'Alice');

  // CTE (with statement)
  const cteResult = await db.with('active_users', (db) =>
    db.selectFrom('users').selectAll().where('name', '=', 'Alice')
  )
    .selectFrom('active_users')
    .selectAll()
    .execute();
  assert.equal(cteResult.length, 1);
  assert.equal(cteResult[0].email, 'alice@example.com');

  // Transaction rollback
  try {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('users').values({
        id: 'u-rollback',
        name: 'Bob',
        email: 'bob@example.com',
      }).execute();
      throw new Error('Forced rollback');
    });
  } catch {
    // expected
  }

  const rolledBack = await db.selectFrom('users').selectAll().where('id', '=', 'u-rollback').executeTakeFirst();
  assert.equal(rolledBack, undefined, 'Rolled back transaction should not persist');

  // Raw PRAGMA query
  const pragma = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
  assert.ok(pragma.rows.length > 0);

  await db.destroy();
});

test('SqliteDatabaseProvider exposes raw sqlite and Kysely handles', async () => {
  const provider = new SqliteDatabaseProvider(':memory:');
  await provider.migrate();

  assert.ok(provider.sqlite instanceof DatabaseSync);
  assert.ok(provider.getKysely());

  // Test extension state through provider
  assert.equal(await provider.getEnabled('ext-1'), false);
  await provider.setEnabled('ext-1', true);
  assert.equal(await provider.getEnabled('ext-1'), true);

  // Test direct Kysely access
  const row = await provider.getKysely().selectFrom('extension_state').selectAll().executeTakeFirst();
  assert.equal(row?.id, 'ext-1');
  assert.equal(row?.enabled, 1);

  await provider.close();
});
