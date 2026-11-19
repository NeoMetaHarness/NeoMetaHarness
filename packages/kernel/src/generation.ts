import type { ExtensionSettingsSchema } from './manifest.js';
import type { RouteHandler } from './index.js';

/** One privately staged extension generation, including all owned registrations. */
export class ExtensionGeneration {
  /** Values and schema belong to this activation, including while staged/draining. */
  readonly settings: Record<string, unknown> = {};
  settingsSchema?: ExtensionSettingsSchema;
  readonly routes = new Map<string, RouteHandler>();
  readonly contributions = new Map<string, { id: string; [key: string]: unknown }>();
  readonly services = new Map<string, unknown>();
  readonly abort = new AbortController();
  private readonly requests = new Set<Promise<void>>();
  private readonly streams = new Set<AsyncIterator<unknown>>();
  private readonly connections = new Set<() => void | Promise<void>>();
  private retiring = false;
  private disposal?: Promise<void>;
  cleanup: () => Promise<void> = async () => {};
  check: () => Promise<{ ok: boolean; pid?: number }> = async () => ({ ok: true });
  changed: () => void = () => {};
  constructor(readonly id: string) {}

  route(path: string, handler: RouteHandler): () => void {
    if (!/^[a-z][a-z0-9/-]*$/.test(path) || path.includes('//') || path.includes('..')) throw new Error(`Invalid route ${path}`);
    const route = `/x/${this.id}/${path}`;
    if (this.routes.has(route)) throw new Error(`Duplicate route ${route}`);
    this.routes.set(route, handler);
    try { this.changed(); } catch (error) { this.routes.delete(route); throw error; }
    return () => { this.routes.delete(route); this.changed(); };
  }
  contribute(kind: string, value: { id: string; [key: string]: unknown }): () => void {
    const key = `${kind}:${value.id}`;
    if (this.contributions.has(key)) throw new Error(`Duplicate contribution ${key}`);
    this.contributions.set(key, value);
    try { this.changed(); } catch (error) { this.contributions.delete(key); throw error; }
    return () => { this.contributions.delete(key); this.changed(); };
  }
  provide(name: string, value: unknown) {
    if (this.services.has(name)) throw new Error(`Duplicate service ${name}`);
    this.services.set(name, value);
    try { this.changed(); } catch (error) { this.services.delete(name); throw error; }
  }
  onDrain(close: () => void | Promise<void>): () => void {
    if (this.retiring) throw new Error('Extension generation is draining');
    this.connections.add(close); return () => { this.connections.delete(close); };
  }
  private acquire(): () => void {
    let release!: () => void;
    const pending = new Promise<void>((done) => { release = done; });
    this.requests.add(pending);
    return () => { this.requests.delete(pending); release(); };
  }
  async invoke(handler: RouteHandler, method: string, body?: unknown): Promise<unknown> {
    if (this.retiring) throw new Error('Extension generation is draining');
    const release = this.acquire();
    try {
      const value = await handler({ method, body, signal: this.abort.signal });
      if (value && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
        const iterator = (value as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        this.streams.add(iterator);
        let released = false;
        const finish = () => { if (!released) { released = true; this.streams.delete(iterator); release(); } };
        // A custom iterator releases even when the caller closes before its first next().
        return {
          [Symbol.asyncIterator]() { return this; },
          async next() { try { const result = await iterator.next(); if (result.done) finish(); return result; } catch (error) { finish(); throw error; } },
          async return() { try { return await iterator.return?.() ?? { done: true, value: undefined }; } finally { finish(); } },
          async throw(error: unknown) { try { if (iterator.throw) return await iterator.throw(error); throw error; } finally { finish(); } },
        };
      }
      release(); return value;
    } catch (error) { release(); throw error; }
  }
  dispose(drainMs = 5000): Promise<void> {
    return this.disposal ??= this.retire(drainMs);
  }
  private async retire(drainMs: number) {
    this.retiring = true;
    this.changed = () => {};
    // Closing owned sockets stops new work arriving through an old connection.
    const closing = Promise.allSettled([...this.connections].map((close) => Promise.resolve().then(close)));
    let timer: NodeJS.Timeout | undefined;
    try {
      const drained = await Promise.race([
        Promise.all([...this.requests, closing]).then(() => true),
        new Promise<false>((done) => { timer = setTimeout(() => done(false), drainMs); }),
      ]);
      if (!drained) {
        this.abort.abort();
        for (const stream of this.streams) void stream.return?.().catch(() => {});
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.abort.abort();
      await this.cleanup();
      this.connections.clear();
    }
  }
}
