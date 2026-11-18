import { Socket } from 'node:net';

/** A bounded, exact-length reader handles arbitrary TCP fragmentation/coalescing. */
export class RfbTransport {
  private buffered = Buffer.alloc(0);
  private failure?: Error;
  private wake?: () => void;
  constructor(readonly socket: Socket, private readonly timeout = 8000) {
    socket.on('data', data => {
      if (this.buffered.length + data.length > 64 * 1024 * 1024) { this.close('RFB receive limit exceeded'); return; }
      this.buffered = Buffer.concat([this.buffered, data]); this.wake?.();
    });
    socket.on('error', () => this.close('RFB connection failed; release and reattach'));
    socket.on('end', () => this.close('RFB disconnected; release and reattach'));
    socket.on('close', () => this.close('RFB disconnected; release and reattach'));
  }
  async read(size: number): Promise<Buffer> {
    if (!Number.isSafeInteger(size) || size < 0 || size > 64 * 1024 * 1024) throw new Error('Invalid RFB read size');
    const timer = setTimeout(() => this.close('RFB response timed out; release and reattach'), this.timeout);
    try {
      while (this.buffered.length < size) {
        if (this.failure) throw this.failure;
        await new Promise<void>(resolve => { this.wake = resolve; });
      }
      if (this.failure) throw this.failure;
      const result = this.buffered.subarray(0, size);
      this.buffered = this.buffered.subarray(size);
      return result;
    } finally { clearTimeout(timer); this.wake = undefined; }
  }
  async write(data: Buffer): Promise<void> {
    if (this.failure || this.socket.destroyed) throw this.failure ?? new Error('RFB disconnected; release and reattach');
    await new Promise<void>((resolve, reject) => this.socket.write(data, error => error ? reject(new Error('RFB write failed')) : resolve()));
  }
  close(message = 'RFB connection released'): void {
    this.failure ??= new Error(message); this.socket.destroy(); this.wake?.();
  }
}
