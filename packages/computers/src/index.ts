import { randomBytes } from 'node:crypto';

export type LeaseHolder = 'agent' | 'human';
export interface ComputerCapabilities {
  screen: boolean;
  input: boolean;
  browserCdp: boolean;
  shell: boolean;
  files: boolean;
  snapshot: boolean;
  gpu?: boolean;
}
export interface StreamEndpoint { protocol: 'png' | 'rfb' | 'webrtc' | 'mjpeg'; url?: string }
export interface Capture { png: string; width: number; height: number }
export type ComputerInput =
  | { action: 'click'; x: number; y: number }
  | { action: 'move'; x: number; y: number }
  | { action: 'type'; text: string }
  | { action: 'key'; keys: string }
  | { action: 'scroll'; direction: string; amount: number };
export type ComputerAction = ComputerInput | { action: 'capture' };

export interface Computer {
  screen(): StreamEndpoint | Promise<StreamEndpoint>;
  lease(holder: LeaseHolder): Promise<void> | void;
  input(action: ComputerInput): Promise<void> | void;
  capture(): Promise<Capture> | Capture;
  browser?(): unknown;
  exec?(command: string): AsyncIterable<string>;
  files?: unknown;
  suspend?(): Promise<void> | void;
  resume?(): Promise<void> | void;
  snapshot?(): Promise<unknown> | unknown;
}
export interface ComputerProvider {
  capabilities: ComputerCapabilities;
  provision(spec: Record<string, unknown>): Computer | Promise<Computer>;
  attach(target: string, context?: ComputerAttachContext): Computer | Promise<Computer>;
  release(id: string): void | Promise<void>;
}
/** Set by the authenticated Gateway, never parsed from an untrusted target string. */
export interface ComputerAttachContext { workspaceId?: string }
export type ComputerNotice =
  | { type: 'computer.acting'; computerId: string; engine: string; active: boolean; action: ComputerAction['action'] }
  | { type: 'computer.lease'; computerId: string; holder: LeaseHolder }
  | { type: 'computer.kill'; engaged: boolean };

export interface ComputerInfo {
  id: string;
  providerId: string;
  capabilities: ComputerCapabilities;
  holder: LeaseHolder;
  assignments: { engine: string; targetId: string }[];
}
export interface ComputerBinding { endpoint: string; token: string; computerId: string }

interface Entry { providerId: string; provider: ComputerProvider; computer: Computer; holder: LeaseHolder; queue: Promise<unknown> }
interface Assignment { engine: string; targetId: string; computerId: string; token: string }

export class ComputerRegistry {
  private readonly providers = new Map<string, ComputerProvider>();
  private readonly entries = new Map<string, Entry>();
  private readonly attaching = new Set<string>();
  private readonly releasing = new Set<string>();
  private readonly assignments = new Map<string, Assignment>();
  private readonly tokens = new Map<string, Assignment>();
  private killed = false;

  constructor(
    private readonly endpoint: () => string,
    private readonly publish: (notice: ComputerNotice) => void,
  ) {}

  registerProvider(name: string, provider: ComputerProvider): () => Promise<void> {
    if (this.providers.has(name)) throw new Error('Duplicate computer provider');
    this.providers.set(name, provider);
    return async () => {
      if (this.providers.get(name) === provider) this.providers.delete(name);
      await Promise.all([...this.entries]
        .filter(([, entry]) => entry.provider === provider)
        .map(([id]) => this.release(id)));
    };
  }

  list(): ComputerInfo[] {
    return [...this.entries].map(([id, entry]) => ({
      id, providerId: entry.providerId,
      capabilities: this.providers.get(entry.providerId)?.capabilities ?? {
        screen: false, input: false, browserCdp: false, shell: false, files: false, snapshot: false,
      },
      holder: entry.holder,
      assignments: [...this.assignments.values()]
        .filter((assignment) => assignment.computerId === id)
        .map(({ engine, targetId }) => ({ engine, targetId })),
    }));
  }

  async attach(providerId: string, target: string, context?: ComputerAttachContext): Promise<ComputerInfo> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error('Computer provider is unavailable');
    if (this.entries.has(target) || this.attaching.has(target) || this.releasing.has(target)) {
      throw new Error('Computer ID already attached');
    }
    this.attaching.add(target);
    try {
      const computer = await provider.attach(target, context);
      // An extension could be disabled while a provider is attaching.
      if (this.providers.get(providerId) !== provider) {
        await provider.release(target);
        throw new Error('Computer provider was disabled');
      }
      this.entries.set(target, { providerId, provider, computer, holder: 'agent', queue: Promise.resolve() });
      return this.list().find((entry) => entry.id === target)!;
    } finally {
      this.attaching.delete(target);
    }
  }

  async release(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.releasing.add(id);
    this.entries.delete(id);
    for (const [key, assignment] of this.assignments) {
      if (assignment.computerId === id) this.revoke(key);
    }
    try {
      await entry.queue.catch(() => {});
      await entry.provider.release(id);
      return true;
    } finally {
      this.releasing.delete(id);
    }
  }

  private key(engine: string, targetId: string): string { return JSON.stringify([engine, targetId]); }

  assign(engine: 'hermes' | 'dsh', targetId: string, computerId: string): ComputerBinding {
    if (!this.entries.has(computerId)) throw new Error('Unknown computer');
    const key = this.key(engine, targetId);
    this.revoke(key);
    const assignment = { engine, targetId, computerId, token: randomBytes(32).toString('hex') };
    this.assignments.set(key, assignment);
    this.tokens.set(assignment.token, assignment);
    return this.binding(engine, targetId)!;
  }

  binding(engine: string, targetId: string): ComputerBinding | undefined {
    const assignment = this.assignments.get(this.key(engine, targetId));
    if (!assignment || !this.entries.has(assignment.computerId)) return undefined;
    return { endpoint: this.endpoint(), token: assignment.token, computerId: assignment.computerId };
  }

  revoke(key: string): void {
    const assignment = this.assignments.get(key);
    if (assignment) this.tokens.delete(assignment.token);
    this.assignments.delete(key);
  }

  unassign(engine: string, targetId: string): void { this.revoke(this.key(engine, targetId)); }

  kill(engaged: boolean): { engaged: boolean } {
    this.killed = engaged;
    this.publish({ type: 'computer.kill', engaged });
    return { engaged };
  }

  state(): { engaged: boolean } { return { engaged: this.killed }; }

  async capture(id: string): Promise<Capture> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Unknown computer');
    return this.runQueued(entry, () => Promise.resolve(entry.computer.capture()));
  }

  async lease(id: string, holder: LeaseHolder): Promise<ComputerInfo> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Unknown computer');
    await this.runQueued(entry, async () => {
      await entry.computer.lease(holder);
      entry.holder = holder;
      this.publish({ type: 'computer.lease', computerId: id, holder });
    });
    return this.list().find((computer) => computer.id === id)!;
  }

  private runQueued<T>(entry: Entry, operation: () => Promise<T>): Promise<T> {
    const running = entry.queue.then(operation, operation);
    entry.queue = running.catch(() => {});
    return running;
  }

  async act(token: string, action: ComputerAction): Promise<{ ok: true; capture?: Capture }> {
    const assignment = this.tokens.get(token);
    if (!assignment) throw new Error('Computer capability denied');
    const entry = this.entries.get(assignment.computerId);
    if (!entry) throw new Error('Computer is detached');
    return this.runQueued(entry, async () => {
      if (this.tokens.get(token) !== assignment) throw new Error('Computer capability revoked');
      if (this.killed) throw new Error('Computer kill switch engaged');
      if (entry.holder === 'human') throw new Error('Computer is leased to a human');
      this.publish({ type: 'computer.acting', computerId: assignment.computerId, engine: assignment.engine,
        active: true, action: action.action });
      try {
        if (action.action === 'capture') return { ok: true, capture: await entry.computer.capture() };
        await entry.computer.input(action);
        return { ok: true };
      } finally {
        this.publish({ type: 'computer.acting', computerId: assignment.computerId, engine: assignment.engine,
          active: false, action: action.action });
      }
    });
  }
}
