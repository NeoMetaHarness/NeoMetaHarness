import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { provePortableKysely } from './db-portable-kysely.mjs';

const temp = await mkdtemp(join(tmpdir(), 'nmh-embedded-pg-'));
const options = {host:'127.0.0.1',port:5544,user:'nmh_spike',password:'ephemeral-spike-only',database:'postgres'};
const server = new EmbeddedPostgres({
  databaseDir:join(temp,'cluster'),port:5544,user:options.user,password:options.password,
  persistent:true,autoRehydrateSymlinks:true,createPostgresUser:false,
  postgresFlags:['-c','listen_addresses=127.0.0.1'],
  onLog:()=>{},onError:()=>{},
});
let started = false;
try {
  await server.initialise();
  await server.start();
  started = true;
  const db = new Kysely({dialect:new PostgresDialect({pool:new Pool({...options,max:1})})});
  try {
    await provePortableKysely(db);
    const version = await db.selectFrom('pg_catalog.pg_settings').select('setting')
      .where('name','=','server_version').executeTakeFirst();
    console.log('KYSELY_NATIVE_POSTGRES PASS version=' + version.setting + ' port=5544');
  } finally { await db.destroy(); }
} catch(error) {
  process.exitCode = 1;
  console.error('DB_EMBEDDED_POSTGRES FAILED ' + (error?.message ?? String(error)));
} finally {
  try { if(started) await server.stop(); } finally {
    await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200});
    console.log('DB_EMBEDDED_POSTGRES_CLEANUP PASS temp=deleted');
  }
}
