// HonchoStore against the scripted fake Honcho: forgetIntent removes only exact (whitespace- and case-normalised)
// copies of a retracted intent, never a different intent that merely shares letters.
import assert from 'node:assert/strict';
import type { VaultService } from '@neometaharness/vault';
// @ts-expect-error: plain .mjs fixture shared with the neo-app end-to-end tests.
import { fakeHoncho } from '../../../apps/neo-app/test/fake-honcho.mjs';
import { HonchoStore } from '../src/store.js';

const honcho = await fakeHoncho('store-test-key');
const vault = { get: async (_scope: unknown, name: string) =>
  name === 'HONCHO_URL' ? honcho.url : name === 'HONCHO_API_KEY' ? 'store-test-key' : undefined } as unknown as VaultService;
const store = new HonchoStore(vault);
const intent = (text: string) => store.add({ workspace: 'w', subject: 'user', subjectId: 'global', text,
  source: 'neo.intent', provenance: 'test', trust: 'confirmed' });
try {
  await intent('pas');
  await intent('pass');
  await intent('  PAS ');
  await store.add({ workspace: 'w', subject: 'user', subjectId: 'global', text: 'pas', source: 'manual',
    provenance: 'test', trust: 'observed' });
  assert.equal(await store.forgetIntent('w', 'pas'), 2, 'both copies of "pas" (any spacing or case) are forgotten');
  const left = (await store.list({ workspace: 'w' })).map((item) => item.text + '|' + item.source).sort();
  assert.deepEqual(left, ['pass|neo.intent', 'pas|manual'], '"pass" and non-intent entries are kept');
  assert.equal(await store.forgetIntent('w', 'pas'), 0, 'forgetting is idempotent');
  console.log('HONCHO_STORE PASS forgetIntent matches whole normalised text only ("pas" never removes "pass")');
} finally {
  await honcho.close();
}
