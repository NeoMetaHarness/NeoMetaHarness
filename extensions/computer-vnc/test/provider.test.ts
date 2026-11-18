import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { inflateSync } from 'node:zlib';
import { VncComputerProvider } from '../src/provider.js';
import { FakeRfbServer } from './fake-rfb.js';

test('provider scopes vault credentials, returns PNG pixels and translates input', async () => {
  const server = await new FakeRfbServer().start();
  const scopes: string[] = [];
  const provider = new VncComputerProvider({ get: async (scope, name) => {
    scopes.push(scope.workspaceId); assert.equal(name, 'VNC_PASSWORD'); return scope.workspaceId === 'allowed' ? 'password' : undefined;
  } });
  const target = `127.0.0.1:${server.port}#VNC_PASSWORD`;
  try {
    await assert.rejects(provider.attach(target), /workspace required/);
    await assert.rejects(provider.attach(target, { workspaceId: 'other' }), /secret unavailable/);
    const computer = await provider.attach(target, { workspaceId: 'allowed' });
    const first = await computer.capture(), png = Buffer.from(first.png, 'base64');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(first.width, 8); assert.equal(first.height, 6);
    const data: Buffer[] = [];
    for (let offset = 8; offset < png.length;) {
      const size = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
      if (type === 'IDAT') data.push(png.subarray(offset + 8, offset + 8 + size)); offset += size + 12;
    }
    assert.deepEqual([...inflateSync(Buffer.concat(data)).subarray(0, 5)], [0, 10, 40, 200, 255]);
    await computer.input({ action: 'move', x: 3, y: 3 });
    await computer.input({ action: 'click', x: 3, y: 3 });
    await computer.input({ action: 'type', text: 'aΩ\n' });
    await computer.input({ action: 'key', keys: 'Ctrl+Left' });
    assert.notEqual((await computer.capture()).png, first.png);
    assert.deepEqual(server.pointers.map(p => p.mask), [0, 1, 0]);
    assert.deepEqual(server.keys.map(k => [k.keysym, k.down]), [[97, true], [97, false], [0x010003a9, true], [0x010003a9, false], [0xff0d, true], [0xff0d, false], [0xffe3, true], [0xff51, true], [0xff51, false], [0xffe3, false]]);
    assert.deepEqual(scopes, ['other', 'allowed']);
    provider.release(target);
    await assert.rejects(Promise.resolve().then(() => computer.capture()), /released|cancelled|disconnected/);
  } finally { provider.close(); await server.close(); }
});

test('disable aborts a socket still negotiating', async () => {
  let connection!: (socket: Socket) => void;
  const connected = new Promise<Socket>(resolve => { connection = resolve; });
  const server = createServer(connection);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = new VncComputerProvider({ get: async () => undefined });
  const pending = provider.attach(`127.0.0.1:${(server.address() as { port: number }).port}`);
  const rejected = assert.rejects(pending, /cancelled|connection failed/);
  const socket = await connected;
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
  try { provider.close(); await rejected; await closed; }
  finally { socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
