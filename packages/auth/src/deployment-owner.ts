import type { DatabaseSync } from 'node:sqlite';
import { sql, type Kysely } from 'kysely';

export async function migrateDeploymentOwner(db: Kysely<any>): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await sql`CREATE TABLE IF NOT EXISTS neo_deployment_owner (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT
    )`.execute(tx);
    // The first committed user insert claims the singleton, even when registrations overlap.
    await sql`CREATE TRIGGER IF NOT EXISTS neo_assign_first_deployment_owner
      AFTER INSERT ON "user" BEGIN
        INSERT OR IGNORE INTO neo_deployment_owner (singleton, user_id) VALUES (1, NEW.id);
      END`.execute(tx);
    await sql`INSERT OR IGNORE INTO neo_deployment_owner (singleton, user_id)
      SELECT 1, id FROM "user" ORDER BY "createdAt", rowid LIMIT 1`.execute(tx);
  });
}

export async function deploymentOwnerId(db: Kysely<any>): Promise<string | undefined> {
  const row = await db.selectFrom('neo_deployment_owner').select('user_id').where('singleton', '=', 1).executeTakeFirst();
  return row?.user_id;
}

/** Read the live singleton on every privileged check, including on established sockets. */
export function deploymentOwnerLookup(sqlite: DatabaseSync): (userId: string) => boolean {
  const find = sqlite.prepare('SELECT 1 FROM neo_deployment_owner WHERE singleton = 1 AND user_id = ?');
  return userId => Boolean(find.get(userId));
}

/** Compare and swap on the authenticated owner's id, atomically with target validation. */
export async function transferDeploymentOwner(db: Kysely<any>, ownerId: string, nextOwnerId: string): Promise<boolean> {
  const updated = await db.updateTable('neo_deployment_owner').set({ user_id: nextOwnerId })
    .where('singleton', '=', 1).where('user_id', '=', ownerId)
    .where('user_id', '!=', nextOwnerId)
    .where(({ exists, selectFrom }) => exists(selectFrom('user').select('id').where('id', '=', nextOwnerId)))
    .returning('user_id').executeTakeFirst();
  return Boolean(updated);
}
