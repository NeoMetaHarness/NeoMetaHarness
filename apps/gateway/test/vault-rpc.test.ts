import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { startGateway } from '../src/server.js';

const scope = { kind: 'engine' as const, workspaceId: 'tenant-a', subjectId: 'hermes-a' };
type VaultClient = ContractRouterClient<typeof neoContract>;

function client(port: number): VaultClient {
  return createORPCClient<VaultClient>(new RPCLink({ url: 'http://127.0.0.1:' + port }));
}

test('vault oRPC denies access by default and enforces scoped authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nmh-vault-rpc-'));
  const databaseFile = join(root, 'gateway.db');
  const extensionsDir = join(root, 'extensions');
  await mkdir(extensionsDir);
  try {
    const denied = await startGateway({ databaseFile, extensionsDir });
    try {
      await assert.rejects(client(denied.port).vault.list({ scope }),
        (error: { code?: string }) => error.code === 'UNAUTHORIZED');
    } finally {
      await denied.close();
    }

    const gateway = await startGateway({
      databaseFile, extensionsDir,
      authorizeVault: (operation, requested) => requested.workspaceId === scope.workspaceId
        && requested.kind === scope.kind && requested.subjectId === scope.subjectId,
    });
    try {
      const rpc = client(gateway.port);
      const value = 'rpc-sensitive-secret-value';
      const created = await rpc.vault.put({ scope, name: 'API_SERVER_KEY', value });
      assert.equal(created.version, 1);
      const listed = await rpc.vault.list({ scope });
      assert.equal(listed.length, 1);
      assert.equal(JSON.stringify(listed).includes(value), false);
      assert.equal((listed[0] as unknown as Record<string, unknown>).value, undefined);
      const rotated = await rpc.vault.rotate({ scope, name: 'API_SERVER_KEY', value: 'rotated-secret' });
      assert.equal(rotated.version, 2);
      await assert.rejects(rpc.vault.put({
        scope: { ...scope, workspaceId: 'tenant-b' }, name: 'OPENAI_API_KEY', value,
      }), (error: { code?: string }) => error.code === 'UNAUTHORIZED');
      assert.deepEqual(await rpc.vault.delete({ scope, name: 'API_SERVER_KEY' }), { deleted: true });
      assert.deepEqual(await rpc.vault.list({ scope }), []);
    } finally {
      await gateway.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
