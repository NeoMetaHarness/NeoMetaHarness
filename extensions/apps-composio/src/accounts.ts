import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AppsActor, AppEngineGrant } from '@neometaharness/kernel';
import { restrictPrivatePath } from '@neometaharness/vault';
type Account = { id: string; toolkit: string; ownerUserId: string; grants: AppEngineGrant[] };
type Workspace = { version: 2; workspaceId: string; accounts: Account[] };
export class AccountStore {
  private readonly workspaces = new Map<string, Workspace>();
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}
  private directoryFor(workspaceId: string) { return join(this.directory, createHash('sha256').update(workspaceId).digest('hex')); }
  async load() {
    await mkdir(this.directory, { recursive: true });
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const data = JSON.parse(await readFile(join(this.directory, entry.name, 'accounts.json'), 'utf8')) as Workspace;
      if (data.version !== 2 || !data.workspaceId || this.directoryFor(data.workspaceId) !== join(this.directory, entry.name)
        || !Array.isArray(data.accounts) || data.accounts.some(a => !a.id || !a.toolkit || !a.ownerUserId || !Array.isArray(a.grants)
          || a.grants.some(g => !['hermes', 'dsh', 'superagent'].includes(g.engine) || !g.profile))) throw new Error('Invalid scoped account store');
      this.workspaces.set(data.workspaceId, data);
    }
    // The old installation-wide accounts.json has no owner evidence. Never infer ownership.
  }
  bindings() { return [...this.workspaces.values()].flatMap(w => w.accounts.flatMap(a => a.grants.map(g => ({ ...g, workspaceId: w.workspaceId })))); }
  authorize(accountId: string, actor: AppsActor): Account {
    const account = this.workspaces.get(actor?.workspaceId)?.accounts.find(a => a.id === accountId);
    if (!account || (actor.kind === 'user' ? account.ownerUserId !== actor.userId
      : !account.grants.some(g => g.engine === actor.engine && g.profile === actor.profile))) throw new Error('Connected account access denied');
    return account;
  }
  find(accountId: string, workspaceId: string) { return this.workspaces.get(workspaceId)?.accounts.find(a => a.id === accountId); }
  private mutate(workspaceId: string, change: (workspace: Workspace) => void) {
    const work = this.pending.then(async () => {
      if (!workspaceId || workspaceId === 'default') throw new Error('Apps workspace required');
      const value = structuredClone(this.workspaces.get(workspaceId) ?? { version: 2 as const, workspaceId, accounts: [] });
      change(value);
      const directory = this.directoryFor(workspaceId); await mkdir(directory, { recursive: true });
      const file = join(directory, 'accounts.json'); const temp = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await restrictPrivatePath(temp); await rename(temp, file); }
      finally { await rm(temp, { force: true }); }
      this.workspaces.set(workspaceId, value);
    });
    this.pending = work.catch(() => {}); return work;
  }
  add(workspaceId: string, account: Omit<Account, 'grants'>) {
    return this.mutate(workspaceId, workspace => {
      if (workspace.accounts.some(a => a.id === account.id)) throw new Error('Connected account already exists');
      workspace.accounts.push({ ...account, grants: [] });
    });
  }
  grant(accountId: string, grant: AppEngineGrant, enabled: boolean, actor: AppsActor) {
    if (actor.kind !== 'user') throw new Error('Only the account owner can grant engine access');
    return this.mutate(actor.workspaceId, workspace => {
      const account = workspace.accounts.find(a => a.id === accountId);
      if (!account || account.ownerUserId !== actor.userId) throw new Error('Connected account access denied');
      account.grants = account.grants.filter(g => g.engine !== grant.engine || g.profile !== grant.profile);
      if (enabled) account.grants.push({ ...grant });
    });
  }
}
