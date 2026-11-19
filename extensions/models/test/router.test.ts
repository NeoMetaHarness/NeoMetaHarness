import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VaultService } from '@neometaharness/vault';
import { ModelHub } from '../src/hub.js';
const home = await mkdtemp(join(tmpdir(), 'neo-router-hook-'));
try {
  const hub = new ModelHub({ get: async () => undefined } as unknown as VaultService, home);
  hub.setActive(true);
  for (const id of ['direct', 'routed']) await hub.saveProvider({ id, kind: 'openai-compatible', baseUrl: 'http://127.0.0.1/v1' });
  await hub.setRole({ role: 'coding', providerId: 'direct', model: 'fallback' });
  const remove = hub.registerRouter({ select: async () => ({ providerId: 'routed', model: 'chosen' }) });
  assert.equal((await hub.resolve('coding')).model, 'chosen');
  await hub.setOverride({ profile: 'custom', providerId: 'direct', model: 'explicit' });
  assert.equal((await hub.resolve('coding', 'custom')).model, 'explicit');
  remove();
  assert.equal((await hub.resolve('coding')).model, 'fallback');
  for (const select of [async () => { throw Error('unavailable'); }, async () => ({ providerId: 'unknown', model: 'bad' })]) {
    const detach = hub.registerRouter({ select });
    assert.equal((await hub.resolve('coding')).model, 'fallback');
    detach();
  }
  console.log('PASS Model Hub routing hook: explicit overrides, routed selection, detach and safe direct fallback');
} finally { await rm(home, { recursive: true, force: true }); }
