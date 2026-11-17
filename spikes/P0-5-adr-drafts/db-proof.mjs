import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
import { sql, eq } from 'drizzle-orm';
import { Kysely, SqliteDialect } from 'kysely';
import { provePortableKysely } from './db-portable-kysely.mjs';
import { upstreamPath } from './upstream-path.mjs';
import fs from 'node:fs';
assert.ok(fs.existsSync(upstreamPath('t3code','packages/contracts/src/rpc.ts')));
const records = sqliteTable('records', {id:integer('id').primaryKey(), name:text('name').notNull()});

// Drizzle: migrate via typed SQL API, then query through schema with a node:sqlite proxy.
{
  const sqlite = new DatabaseSync(':memory:');
  try {
    const db = drizzle(async (query, params, method) => {
      const stmt = sqlite.prepare(query);
      stmt.setReturnArrays(true);
      if (method === 'run') { stmt.run(...params); return {rows:[]}; }
      return {rows:stmt.all(...params)};
    });
    await db.run(sql.raw('CREATE TABLE records(id integer primary key, name text not null)'));
    await db.insert(records).values({id:1,name:'neo'}).run();
    assert.deepEqual((await db.select().from(records).where(eq(records.id,1)).all()).map(x=>x.name), ['neo']);
    console.log('DRIZZLE_SQLITE PASS migration=drizzle.run(raw SQL), insert/select, node:sqlite proxy');
  } finally { sqlite.close(); }
}

// Kysely: portable schema builder migration and typed query API using node:sqlite.
{
  const sqlite = new DatabaseSync(':memory:');
  const db = new Kysely({dialect:new SqliteDialect({database:{prepare(query){const stmt=sqlite.prepare(query);return {reader:query.trimStart().toLowerCase().startsWith('select'), run:(params)=>stmt.run(...params), all:(params)=>stmt.all(...params), iterate:(params)=>stmt.iterate(...params)}}, close(){sqlite.close()}}})});
  try {
    await provePortableKysely(db);
    console.log('KYSELY_SQLITE PASS migration=schema builder, insert/select, node:sqlite');
  } finally { await db.destroy(); }
}
console.log('DB_SQLITE_PROOF PASS');
