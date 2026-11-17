import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { PGliteDialect } from 'kysely-pglite-dialect';
import { drizzle } from 'drizzle-orm/pglite';
import { pgTable, integer, text } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { provePortableKysely } from './db-portable-kysely.mjs';

const records = pgTable('records', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});

for (let trial = 1; trial <= 2; trial++) {
  const pg = new PGlite(); // Separate in-memory PostgreSQL database for each trial.
  const db = new Kysely({ dialect: new PGliteDialect(pg) });
  try {
    await provePortableKysely(db);
    console.log('KYSELY_PGLITE PASS trial=' + trial + ' shared=db-portable-kysely.mjs');
  } finally {
    await db.destroy();
  }

  const pgDrizzle = new PGlite();
  try {
    const d = drizzle(pgDrizzle);
    await pgDrizzle.exec('CREATE TABLE records (id integer PRIMARY KEY, name text NOT NULL)');
    await d.insert(records).values({ id: 1, name: 'neo' });
    const result = await d.select().from(records).where(eq(records.id, 1));
    assert.deepEqual(result.map(row => row.name), ['neo']);
    console.log('DRIZZLE_PGLITE PASS trial=' + trial + ' pgTable declaration');
  } finally {
    await pgDrizzle.close();
  }
}
console.log('DB_PGLITE_PROOF PASS trials=2');
