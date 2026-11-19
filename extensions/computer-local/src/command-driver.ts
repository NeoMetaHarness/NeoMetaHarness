import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import type { Capture } from '@neometaharness/computers';
import type { LocalDriver } from './provider.js';

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };

/**
 * A locally installed cua-driver-compatible adapter speaks newline-delimited JSON.
 * Each request is {id, method, params} and the reply is {id, result} or {id, error}.
 * Spawn is shell-free. Closing the process interrupts queued native input.
 */
export class CommandLocalDriver implements LocalDriver {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private closed = false;

  constructor(executable = process.env.NEO_CUA_DRIVER_PATH) {
    if (!executable || !isAbsolute(executable)) {
      throw new Error('Set NEO_CUA_DRIVER_PATH to an absolute local driver executable');
    }
    this.child = spawn(executable, ['--stdio-json'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.resume();
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', () => this.fail(new Error('Local desktop driver exited')));
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      try {
        const reply = JSON.parse(line) as { id: number; result?: unknown; error?: string };
        const pending = this.pending.get(reply.id);
        if (!pending) return;
        this.pending.delete(reply.id);
        clearTimeout(pending.timer);
        reply.error ? pending.reject(new Error('Local driver operation failed')) : pending.resolve(reply.result);
      } catch { this.fail(new Error('Malformed response from local driver')); }
    });
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.child.kill();
  }

  private request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Local driver closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.fail(new Error('Local driver timed out'));
        reject(new Error('Local driver timed out'));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
        if (error) this.fail(error);
      });
    });
  }

  async screenshot(): Promise<Capture> {
    const shot = await this.request('screenshot') as Capture;
    if (!shot || typeof shot.png !== 'string' || !Number.isInteger(shot.width) || !Number.isInteger(shot.height)
      || shot.width <= 0 || shot.height <= 0) throw new Error('Invalid local driver screenshot');
    return shot;
  }
  async click(x: number, y: number): Promise<void> { await this.request('click', { x, y }); }
  async move(x: number, y: number): Promise<void> { await this.request('move', { x, y }); }
  async type(text: string): Promise<void> { await this.request('type', { text }); }
  async key(keys: string): Promise<void> { await this.request('key', { keys }); }
  async scroll(direction: string, amount: number): Promise<void> { await this.request('scroll', { direction, amount }); }
  close(): void { this.fail(new Error('Local driver control revoked')); }
}
