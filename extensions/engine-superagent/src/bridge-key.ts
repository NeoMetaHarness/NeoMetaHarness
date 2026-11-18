// The superagent's MCP bridge calls the Gateway with its own API key (SEC-11).
// The key is short-lived, rotated, swept after crashes, and there is no
// fallback to an operator master token: without a key the bridge fails closed.

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { restrictPrivatePath } from '@neometaharness/vault';

export const BRIDGE_KEY_NAME = 'superagent-bridge';

/** Atomically replace the owner-only token file the MCP bridge reads; empty clears it. */
export async function writeTokenFile(file: string, token: string | undefined): Promise<void> {
  if (!token) { await rm(file, { force: true }); return; }
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, token, { encoding: 'utf8', mode: 0o600 });
  await restrictPrivatePath(tmp);
  await rename(tmp, file);
}
/** Key lifetime. Rotation runs well inside it, so a long ticket never outlives its key. */
export const BRIDGE_KEY_TTL_SECONDS = 7 * 24 * 60 * 60;
export const BRIDGE_KEY_ROTATE_MS = 24 * 60 * 60 * 1000;

export interface BridgeKeyHandle { id: string; token: string }

/**
 * Environment for the MCP bridge child. It points at a token file (re-read per
 * call, so rotation needs no restart) and never forwards NMH_GATEWAY_TOKEN.
 */
export function bridgeEnv(home: string, tokenFile?: string): Record<string, string> {
  return { DSH_HOME: home, ...(tokenFile ? { NMH_GATEWAY_TOKEN_FILE: tokenFile } : {}) };
}

export class BridgeKey {
  constructor(private readonly auth: any) {}

  /** Remove bridge keys left by an earlier run that did not shut down cleanly. */
  async sweep(): Promise<number> {
    const kysely = this.auth?.kysely;
    if (!kysely) return 0;
    const result = await kysely.deleteFrom('apiKey').where('name', '=', BRIDGE_KEY_NAME).executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }

  /**
   * Mint a member key for a real workspace owner (API key roles are capped at
   * the owner's membership). Returns undefined when no owner exists yet.
   */
  async mint(): Promise<BridgeKeyHandle | undefined> {
    if (!this.auth?.api?.createApiKey || !this.auth.kysely) return undefined;
    const owner = await this.auth.kysely.selectFrom('member').select(['userId', 'organizationId'])
      .where('role', '=', 'owner').orderBy('createdAt').executeTakeFirst();
    if (!owner?.userId) return undefined;
    const created = await this.auth.api.createApiKey({
      body: {
        userId: owner.userId,
        name: BRIDGE_KEY_NAME,
        rateLimitEnabled: false,
        expiresIn: BRIDGE_KEY_TTL_SECONDS,
        metadata: { role: 'member', workspaceId: owner.organizationId },
      },
    });
    return created?.key && created?.id ? { id: created.id, token: created.key } : undefined;
  }

  async revoke(id: string): Promise<void> {
    await this.auth?.kysely?.deleteFrom('apiKey').where('id', '=', id).execute();
  }
}
