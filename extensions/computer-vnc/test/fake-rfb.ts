import { createServer, type Socket } from 'node:net';

/** Independent, local-only RFB fixture. No VNC package or real desktop/account. */
export class FakeRfbServer {
  readonly sockets = new Set<Socket>();
  readonly keys: { down: boolean; keysym: number }[] = [];
  readonly pointers: { mask: number; x: number; y: number }[] = [];
  readonly server = createServer(socket => {
    this.sockets.add(socket); socket.setNoDelay(true);
    socket.on('error', () => {}); socket.on('close', () => this.sockets.delete(socket));
    void this.serve(socket).catch(() => socket.destroy());
  });
  port = 0;
  clicked = false;
  authenticated = 0;
  formatReceived = false;
  width = 8;
  height = 6;
  constructor(readonly options: { security?: 'none' | 'vnc' | 'both'; badCopy?: boolean; stallUpdates?: boolean } = {}) {}
  async start(): Promise<this> {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    this.port = (this.server.address() as { port: number }).port; return this;
  }
  private async serve(socket: Socket) {
    const iterator = socket[Symbol.asyncIterator](); let bytes = Buffer.alloc(0);
    const read = async (length: number) => {
      while (bytes.length < length) {
        const next = await iterator.next(); if (next.done) throw new Error('client gone');
        bytes = Buffer.concat([bytes, next.value]);
      }
      const result = bytes.subarray(0, length); bytes = bytes.subarray(length); return result;
    };
    const send = async (data: Buffer) => {
      // Deliberately split fields across TCP writes, independently of client read sizes.
      socket.write(data.subarray(0, 1));
      await new Promise<void>(resolve => setImmediate(resolve));
      socket.write(data.subarray(1, 5));
      await new Promise<void>(resolve => setImmediate(resolve));
      socket.write(data.subarray(5));
    };
    await send(Buffer.from('RFB 003.008\n'));
    if ((await read(12)).toString() !== 'RFB 003.008\n') throw new Error('bad version');
    const offered = this.options.security === 'none' ? [1] : this.options.security === 'both' ? [1, 2] : [2];
    socket.write(Buffer.from([offered.length, ...offered]));
    const security = (await read(1))[0]; if (!offered.includes(security)) throw new Error('bad security');
    if (security === 2) {
      await send(Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'));
      // Fixed independent vector: password="password", reversed DES key=0e86ceceeef64e26.
      if (!(await read(16)).equals(Buffer.from('b866924125c8eebb9debc1db61c538e2', 'hex'))) {
        const reason = Buffer.from('Do not forward: password wrong-secret-marker');
        const header = Buffer.alloc(8); header.writeUInt32BE(1); header.writeUInt32BE(reason.length, 4);
        socket.end(Buffer.concat([header, reason])); return;
      }
    }
    this.authenticated++; socket.write(Buffer.alloc(4)); await read(1);
    const init = Buffer.alloc(24); init.writeUInt16BE(this.width); init.writeUInt16BE(this.height, 2);
    init[4] = 32; init[5] = 24; init[7] = 1; init.writeUInt16BE(255, 8); init.writeUInt16BE(255, 10); init.writeUInt16BE(255, 12); init[14] = 16; init[15] = 8;
    await send(init); // Empty desktop name.
    while (!socket.destroyed) {
      const type = (await read(1))[0];
      if (type === 0) {
        const format = await read(19); this.formatReceived = format[3] === 32 && format[6] === 1 && format[13] === 16;
      } else if (type === 2) { const header = await read(3); await read(header.readUInt16BE(1) * 4); }
      else if (type === 3) { await read(9); if (!this.options.stallUpdates) await send(this.frame()); }
      else if (type === 5) {
        const pointer = await read(5), mask = pointer[0], x = pointer.readUInt16BE(1), y = pointer.readUInt16BE(3);
        this.pointers.push({ mask, x, y }); if (mask & 1) this.clicked = !this.clicked;
      } else if (type === 4) { const key = await read(7); this.keys.push({ down: key[0] === 1, keysym: key.readUInt32BE(3) }); }
      else throw new Error('unsupported client message');
    }
  }
  private frame(): Buffer {
    const raw = Buffer.alloc(this.width * this.height * 4);
    for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
      const i = (y * this.width + x) * 4;
      const rgb = x < 2 && y < 2 ? (this.keys.length ? [250, 220, 10] : [10, 40, 200]) : this.clicked ? [20, 210, 50] : [220, 20, 30];
      raw[i] = rgb[2]; raw[i + 1] = rgb[1]; raw[i + 2] = rgb[0];
    }
    const full = Buffer.alloc(12); full.writeUInt16BE(this.width, 4); full.writeUInt16BE(this.height, 6);
    const copy = Buffer.alloc(16); copy.writeUInt16BE(4, 0); copy.writeUInt16BE(2, 2); copy.writeUInt16BE(2, 4); copy.writeUInt16BE(2, 6); copy.writeInt32BE(1, 8);
    copy.writeUInt16BE(this.options.badCopy ? this.width : 0, 12);
    return Buffer.concat([Buffer.from([0, 0, 0, 2]), full, raw, copy]);
  }
  drop(): void { for (const socket of this.sockets) socket.destroy(); }
  async close(): Promise<void> { this.drop(); await new Promise<void>(resolve => this.server.close(() => resolve())); }
}
