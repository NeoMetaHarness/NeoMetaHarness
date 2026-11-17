import assert from 'node:assert/strict';

// Same migration and query body for either dialect (SQLite or PostgreSQL).
export async function provePortableKysely(db, namespace) {
  const schema = namespace ? db.schema.withSchema(namespace) : db.schema;
  const scoped = namespace ? db.withSchema(namespace) : db;
  await schema.createTable('records')
    .addColumn('id', 'integer', col=>col.primaryKey())
    .addColumn('name', 'text', col=>col.notNull()).execute();
  await scoped.insertInto('records').values({id:1,name:'neo'}).execute();
  const rows = await scoped.selectFrom('records').select('name').where('id','=',1).execute();
  assert.deepEqual(rows.map(row=>row.name), ['neo']);
}
