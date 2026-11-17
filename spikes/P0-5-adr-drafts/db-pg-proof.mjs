import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, integer, text } from 'drizzle-orm/pg-core';
import { sql, eq } from 'drizzle-orm';
import { Kysely, PostgresDialect } from 'kysely';
import { provePortableKysely } from './db-portable-kysely.mjs';
import { upstreamPath } from './upstream-path.mjs';

assert.ok(fs.existsSync(upstreamPath('t3code','packages/contracts/src/rpc.ts')));
if (process.env.NMH_PG_ISOLATED !== '1' || !process.env.NMH_PG_TEST_URL) {
  console.log('DB_POSTGRES BLOCKED (requires disposable local Docker PostgreSQL; set NMH_PG_ISOLATED=1 and NMH_PG_TEST_URL)');
  process.exit(0);
}
const url = new URL(process.env.NMH_PG_TEST_URL);
assert.ok(['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname), 'Postgres must be an isolated localhost container');

// All objects are schema-qualified; no pooled connection relies on SET search_path.
const suffix = randomUUID().replaceAll('-','').slice(0,12);
const dSchema = `nmh_d_${suffix}`, kSchema = `nmh_k_${suffix}`;
const records = pgSchema(dSchema).table('records', {id:integer('id').primaryKey(),name:text('name').notNull()});
const admin = new Pool({connectionString:process.env.NMH_PG_TEST_URL, max:1});
const kysely = new Kysely({dialect:new PostgresDialect({pool:new Pool({connectionString:process.env.NMH_PG_TEST_URL,max:1})})});
try {
  await admin.query(`CREATE SCHEMA "${dSchema}"`);
  await admin.query(`CREATE SCHEMA "${kSchema}"`);

  // Drizzle migration / insert / select using a schema-qualified table declaration.
  const db = drizzle({client:admin});
  await db.execute(sql.raw(`CREATE TABLE "${dSchema}"."records" (id integer PRIMARY KEY, name text NOT NULL)`));
  await db.insert(records).values({id:1,name:'neo'});
  assert.equal((await db.select().from(records).where(eq(records.id,1)))[0].name, 'neo');

  // Kysely portable schema-builder migration / insert / select, also qualified.
  await provePortableKysely(kysely, kSchema);
  console.log('DB_POSTGRES PASS Drizzle + Kysely migrations/query, separate disposable schemas');
} finally {
  await kysely.destroy();
  // Both names were generated above; cleanup cannot touch unrelated schemas.
  await admin.query(`DROP SCHEMA IF EXISTS "${kSchema}" CASCADE`);
  await admin.query(`DROP SCHEMA IF EXISTS "${dSchema}" CASCADE`);
  await admin.end();
}
