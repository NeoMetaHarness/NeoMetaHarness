import { createConnection } from 'node:net';
import { RfbTransport } from './transport.js';
import { vncResponse } from './auth.js';

/** RFB 3.8 wire implementation. Section numbers refer to RFC 6143:
 * https://www.rfc-editor.org/rfc/rfc6143.html */
export class RfbClient {
  width = 0;
  height = 0;
  pixels = Buffer.alloc(0); // RGBA, top-to-bottom, independent of server pixel format.
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private readonly io: RfbTransport) {}
  static async connect(host: string, port: number, password?: string, timeout = 8000, signal?: AbortSignal): Promise<RfbClient> {
    if (signal?.aborted) throw new Error('RFB attachment cancelled');
    const socket = createConnection({ host, port });
    socket.setNoDelay(true);
    const io = new RfbTransport(socket, timeout), client = new RfbClient(io);
    const aborted = () => io.close('RFB attachment cancelled');
    signal?.addEventListener('abort', aborted, { once: true });
    socket.once('close', () => signal?.removeEventListener('abort', aborted));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('RFB connect timed out')); }, timeout);
        const cleanup = () => { clearTimeout(timer); socket.off('connect', connected); socket.off('error', failed); socket.off('close', failed); };
        const connected = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('RFB connection failed')); };
        socket.once('connect', connected); socket.once('error', failed); socket.once('close', failed);
      });
      await client.initialize(password);
      return client;
    } catch (error) { io.close(); throw error; }
  }
  private async initialize(password?: string) {
    // §§7.1.1–7.1.3, 7.2: negotiate exactly 3.8; never silently downgrade authentication.
    if ((await this.io.read(12)).toString('ascii') !== 'RFB 003.008\n') throw new Error('RFB 3.8 is required');
    await this.io.write(Buffer.from('RFB 003.008\n'));
    const count = (await this.io.read(1))[0];
    if (!count) throw new Error('RFB server refused connection');
    const offered = await this.io.read(count), security = password === undefined ? 1 : 2;
    if (!offered.includes(security)) throw new Error('Requested RFB security type unavailable');
    await this.io.write(Buffer.from([security]));
    if (security === 2) {
      const response = vncResponse(await this.io.read(16), password!);
      try { await this.io.write(response); } finally { response.fill(0); }
    }
    // Never propagate a server-supplied failure reason: it could echo credentials.
    if ((await this.io.read(4)).readUInt32BE() !== 0) throw new Error('RFB authentication rejected');
    // §§7.3.1–7.3.2: shared ClientInit and bounded ServerInit.
    await this.io.write(Buffer.from([1]));
    const init = await this.io.read(24);
    this.width = init.readUInt16BE(0); this.height = init.readUInt16BE(2);
    if (!this.width || !this.height || this.width * this.height > 16_777_216) throw new Error('RFB framebuffer dimensions exceed limit');
    const nameLength = init.readUInt32BE(20);
    if (nameLength > 1024 * 1024) throw new Error('RFB desktop name exceeds limit');
    await this.io.read(nameLength); // Names are untrusted and never displayed/logged.
    this.pixels = Buffer.alloc(this.width * this.height * 4);
    for (let i = 3; i < this.pixels.length; i += 4) this.pixels[i] = 255;
    // §7.4.1: request 32-bit little-endian true color, RGB888 (wire bytes B,G,R,0).
    const format = Buffer.alloc(20); format[4] = 32; format[5] = 24; format[7] = 1;
    format.writeUInt16BE(255, 8); format.writeUInt16BE(255, 10); format.writeUInt16BE(255, 12);
    format[14] = 16; format[15] = 8;
    await this.io.write(format);
    // §7.4.2: only Raw and CopyRect, §§7.6.1–7.6.2.
    const encodings = Buffer.alloc(12); encodings[0] = 2; encodings.writeUInt16BE(2, 2);
    encodings.writeInt32BE(0, 4); encodings.writeInt32BE(1, 8);
    await this.io.write(encodings);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const running = this.queue.then(work); this.queue = running.catch(() => {}); return running;
  }
  capture(): Promise<Buffer> {
    return this.serial(async () => {
      const deadline = setTimeout(() => this.io.close('RFB framebuffer update timed out; release and reattach'), 15000);
      try {
        // §7.4.3: non-incremental request guarantees a response even on a static screen.
        const request = Buffer.alloc(10); request[0] = 3;
        request.writeUInt16BE(this.width, 6); request.writeUInt16BE(this.height, 8);
        await this.io.write(request);
        for (let messages = 0; messages < 4096; messages++) {
          const type = (await this.io.read(1))[0];
          if (type === 0) { await this.update(); return Buffer.from(this.pixels); }
          if (type === 2) continue; // §7.5.3 Bell.
          if (type === 3) { // §7.5.4 ServerCutText; intentionally no clipboard integration.
            const header = await this.io.read(7), length = header.readUInt32BE(3);
            if (length > 1024 * 1024) throw new Error('RFB clipboard exceeds limit');
            await this.io.read(length); continue;
          }
          throw new Error('Unsupported RFB server message');
        }
        throw new Error('RFB response message limit exceeded');
      } catch (error) { this.close(); throw error; }
      finally { clearTimeout(deadline); }
    });
  }
  private bounds(x: number, y: number, w: number, h: number) {
    if (x + w > this.width || y + h > this.height) throw new Error('RFB rectangle outside framebuffer');
  }
  private async update() {
    // §7.5.1: rectangles apply in wire order; CopyRect may overlap its source.
    const count = (await this.io.read(3)).readUInt16BE(1);
    if (count > 4096) throw new Error('RFB rectangle count exceeds limit');
    for (let i = 0; i < count; i++) {
      const header = await this.io.read(12);
      const x = header.readUInt16BE(0), y = header.readUInt16BE(2), w = header.readUInt16BE(4), h = header.readUInt16BE(6), encoding = header.readInt32BE(8);
      this.bounds(x, y, w, h);
      if (encoding === 0) {
        const raw = await this.io.read(w * h * 4);
        for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
          const src = (row * w + col) * 4, dst = ((y + row) * this.width + x + col) * 4;
          this.pixels[dst] = raw[src + 2]; this.pixels[dst + 1] = raw[src + 1]; this.pixels[dst + 2] = raw[src]; this.pixels[dst + 3] = 255;
        }
      } else if (encoding === 1) {
        const source = await this.io.read(4), sx = source.readUInt16BE(), sy = source.readUInt16BE(2);
        this.bounds(sx, sy, w, h);
        const copy = Buffer.alloc(w * h * 4);
        for (let row = 0; row < h; row++) this.pixels.copy(copy, row * w * 4, ((sy + row) * this.width + sx) * 4, ((sy + row) * this.width + sx + w) * 4);
        for (let row = 0; row < h; row++) copy.copy(this.pixels, ((y + row) * this.width + x) * 4, row * w * 4, (row + 1) * w * 4);
      } else throw new Error('Unsupported RFB rectangle encoding');
    }
  }
  pointer(x: number, y: number, mask = 0): Promise<void> {
    return this.serial(async () => {
      // §7.4.5: button mask and unsigned framebuffer coordinates.
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.width || y >= this.height || !Number.isInteger(mask) || mask < 0 || mask > 255) throw new Error('Invalid RFB pointer');
      const message = Buffer.alloc(6); message[0] = 5; message[1] = mask;
      message.writeUInt16BE(x, 2); message.writeUInt16BE(y, 4); await this.io.write(message);
    });
  }
  key(keysym: number, down: boolean): Promise<void> {
    return this.serial(async () => {
      // §7.4.4: X11 keysym, network byte order.
      if (!Number.isInteger(keysym) || keysym < 0 || keysym > 0xffffffff) throw new Error('Invalid RFB keysym');
      const message = Buffer.alloc(8); message[0] = 4; message[1] = down ? 1 : 0;
      message.writeUInt32BE(keysym, 4); await this.io.write(message);
    });
  }
  close(): void { this.io.close(); }
}
