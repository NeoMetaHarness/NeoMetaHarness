import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { VaultRecordStore, VaultScopeKind, VaultStoredSecret } from '@neometaharness/db';
import type { Projector } from './projectors.js';

export { KeyFileProvider, restrictPrivatePath, type KeyProvider } from './key.js';
export { HermesProjector, DshProjector, type Projector } from './projectors.js';
import type { KeyProvider } from './key.js';

export interface VaultScope {
  kind: VaultScopeKind;
  workspaceId: string;
  subjectId?: string;
}

export interface VaultMetadata {
  scope: VaultScope;
  name: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

function normalize(scope: VaultScope): Required<VaultScope> {
  if (!['workspace', 'bot', 'engine'].includes(scope.kind)
    || typeof scope.workspaceId !== 'string' || !scope.workspaceId.trim()
    || (scope.kind === 'workspace' && scope.subjectId !== undefined)
    || (scope.kind !== 'workspace' && (typeof scope.subjectId !== 'string' || !scope.subjectId.trim()))) {
    throw new Error('Invalid vault scope');
  }
  return { kind: scope.kind, workspaceId: scope.workspaceId, subjectId: scope.subjectId ?? '' };
}

function scopeKey(scope: VaultScope): string {
  const value = normalize(scope);
  return JSON.stringify([value.kind, value.workspaceId, value.subjectId]);
}

function recordId(scope: VaultScope, name: string): string {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) throw new Error('Invalid credential name');
  return JSON.stringify([scopeKey(scope), name]);
}

function metadata(record: VaultStoredSecret): VaultMetadata {
  return {
    scope: {
      kind: record.scopeKind, workspaceId: record.workspaceId,
      ...(record.scopeKind === 'workspace' ? {} : { subjectId: record.subjectId }),
    },
    name: record.name, version: record.version,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
  };
}

function encrypt(value: string, key: Buffer, id: string, version: number) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify([id, version])));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decrypt(record: VaultStoredSecret, key: Buffer): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify([record.id, record.version])));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    const result = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final(),
    ]);
    return result.toString('utf8');
  } catch {
    throw new Error('Vault integrity check failed');
  }
}

/** One encrypted Kysely-backed store, with scope-specific engine projections. */
export class VaultService {
  private readonly bindings = new Map<string, Set<Projector>>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly records: VaultRecordStore, private readonly keys: KeyProvider) {}

  bind(scope: VaultScope, projector: Projector): () => void {
    const key = scopeKey(scope);
    const targets = this.bindings.get(key) ?? new Set<Projector>();
    targets.add(projector);
    this.bindings.set(key, targets);
    return () => {
      targets.delete(projector);
      if (!targets.size) this.bindings.delete(key);
    };
  }

  async get(scope: VaultScope, name: string): Promise<string | undefined> {
    const row = await this.records.getVaultSecret(recordId(scope, name));
    return row ? decrypt(row, await this.keys.getKey()) : undefined;
  }

  async list(scope: VaultScope): Promise<VaultMetadata[]> {
    const { kind, workspaceId, subjectId } = normalize(scope);
    return (await this.records.listVaultSecrets(kind, workspaceId, subjectId)).map(metadata);
  }

  async put(scope: VaultScope, name: string, value: string): Promise<VaultMetadata> {
    return this.write(scope, name, value, false);
  }

  async rotate(scope: VaultScope, name: string, value: string): Promise<VaultMetadata> {
    return this.write(scope, name, value, true);
  }

  private async write(scope: VaultScope, name: string, value: string, onlyExisting: boolean): Promise<VaultMetadata> {
    const id = recordId(scope, name);
    if (typeof value !== 'string' || !value.length) throw new Error('Credential must have a nonempty value');
    const normalized = normalize(scope);
    const key = await this.keys.getKey();
    for (let attempt = 0; attempt < 5; attempt++) {
      const previous = await this.records.getVaultSecret(id);
      if (onlyExisting && !previous) throw new Error('Credential does not exist');
      const version = (previous?.version ?? 0) + 1;
      const timestamp = Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1);
      const row: VaultStoredSecret = {
        id, scopeKind: normalized.kind, workspaceId: normalized.workspaceId,
        subjectId: normalized.subjectId, name,
        ...encrypt(value, key, id, version),
        version, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp,
      };
      if (await this.records.writeVaultSecret(row, previous?.version ?? null)) {
        await this.sync(scope);
        return metadata(row);
      }
    }
    throw new Error('Vault update conflicted with another writer');
  }

  async delete(scope: VaultScope, name: string): Promise<boolean> {
    const deleted = await this.records.deleteVaultSecret(recordId(scope, name));
    if (deleted) await this.sync(scope);
    return deleted;
  }

  /** Reconcile projections after a restart or an external projection failure. */
  async sync(scope: VaultScope): Promise<void> {
    const key = scopeKey(scope);
    if (!this.bindings.get(key)?.size) return;
    const previous = this.pending.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const normalized = normalize(scope);
      const rows = await this.records.listVaultSecrets(normalized.kind, normalized.workspaceId, normalized.subjectId);
      const keyMaterial = await this.keys.getKey();
      const secrets = new Map(rows.map((row) => [row.name, decrypt(row, keyMaterial)]));
      for (const projector of this.bindings.get(key) ?? []) await projector.project(secrets);
    });
    this.pending.set(key, current);
    try { await current; } finally {
      if (this.pending.get(key) === current) this.pending.delete(key);
    }
  }
}