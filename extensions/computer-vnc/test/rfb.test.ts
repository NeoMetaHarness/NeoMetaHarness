import test from 'node:test';
import assert from 'node:assert/strict';
import { vncResponse } from '../src/auth.js';
import { RfbClient } from '../src/rfb.js';
import { FakeRfbServer } from './fake-rfb.js';

test('VNC bit reversal matches independent DES known-answer vector', () => {
  // FIPS DES key 133457799BBCDFF1, plaintext 0123456789ABCDEF -> 85E813540F0AB405.
  const password = Buffer.from('c82cea9ed93dfb8f', 'hex').toString('latin1');
  assert.equal(vncResponse(Buffer.from('0123456789abcdef'.repeat(2), 'hex'), password).toString('hex'), '85e813540f0ab405'.repeat(2));
  const challenge = Buffer.alloc(16);
  assert.deepEqual(vncResponse(challenge, 'passwordΩextra'), vncResponse(challenge, 'password'), 'only the first eight bytes participate');
});

test('RFB 3.8 VNC-auth, fragmented Raw+CopyRect and pointer/key messages', async () => {
  const server = await new FakeRfbServer().start(); let client: RfbClient | undefined;
  try {
    client = await RfbClient.connect('127.0.0.1', server.port, 'password');
    const image = await client.capture();
    assert.equal(server.formatReceived, true);
    assert.deepEqual([...image.subarray(0, 4)], [10, 40, 200, 255]);
    assert.deepEqual([...image.subarray((2 * 8 + 4) * 4, (2 * 8 + 5) * 4)], [10, 40, 200, 255]);
    await client.pointer(3, 3, 1); await client.pointer(3, 3, 0);
    await client.key(0x61, true); await client.key(0x61, false);
    const changed = await client.capture(); assert.notDeepEqual(changed, image);
    assert.deepEqual([...changed.subarray((3 * 8 + 3) * 4, (3 * 8 + 4) * 4)], [20, 210, 50, 255]);
    assert.deepEqual(server.keys, [{ down: true, keysym: 0x61 }, { down: false, keysym: 0x61 }]);
    server.drop(); await new Promise(resolve => setTimeout(resolve, 20));
    await assert.rejects(client.capture(), /disconnected.*reattach/);
  } finally { client?.close(); await server.close(); }
});

test('None, credential rejection without reason leakage, and no auth downgrade', async () => {
  const server = await new FakeRfbServer({ security: 'none' }).start(); let client: RfbClient | undefined;
  try {
    client = await RfbClient.connect('127.0.0.1', server.port); assert.equal((await client.capture()).length, 8 * 6 * 4);
    await assert.rejects(RfbClient.connect('127.0.0.1', server.port, 'password'), /security type unavailable/);
  } finally { client?.close(); await server.close(); }
  const secured = await new FakeRfbServer().start();
  try {
    await assert.rejects(RfbClient.connect('127.0.0.1', secured.port, 'wrong-secret-marker'), error => {
      assert.doesNotMatch(String(error), /password|wrong-secret-marker/); return /authentication rejected|disconnected/.test(String(error));
    });
  } finally { await secured.close(); }
});

test('out-of-bounds CopyRect and unresponsive server fail and close', async () => {
  for (const options of [{ badCopy: true }, { stallUpdates: true }]) {
    const server = await new FakeRfbServer(options).start(); let client: RfbClient | undefined;
    try {
      client = await RfbClient.connect('127.0.0.1', server.port, 'password', 200);
      await assert.rejects(client.capture(), /outside framebuffer|timed out/);
    } finally { client?.close(); await server.close(); }
  }
});
