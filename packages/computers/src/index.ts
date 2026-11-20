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
export type ComputerAction = ComputerInput | { action: 'capture' } | { action: 'status' } | { action: 'navigate'; url: string };
export interface ComputerSafetyPolicy { allowDestructiveKeys: boolean; navigationOrigins: string[] }

export interface Computer {
  screen(): StreamEndpoint | Promise<StreamEndpoint>;
  lease(holder: LeaseHolder): Promise<void> | void;
  input(action: ComputerInput): Promise<void> | void;
  capture(): Promise<Capture> | Capture;
  navigate?(url: string): Promise<void> | void;
  /** Synchronous preemption for human takeover and the global kill switch. */
  interrupt?(): void;
  resumeInput?(): void;
  browser?(): unknown;
  exec?(command: string): AsyncIterable<string>;
  files?: unknown;
  suspend?(): Promise<void> | void;
  resume?(): Promise<void> | void;
  snapshot?(): Promise<unknown> | unknown;
}
export interface ComputerProvider {
  capabilities: ComputerCapabilities;
  provision(spec: Record<string, unknown>, context?: ComputerAttachContext): Computer | Promise<Computer>;
  attach(target: string, context?: ComputerAttachContext): Computer | Promise<Computer>;
  release(id: string): void | Promise<void>;
  terminate?(id: string): void | Promise<void>;
}
/** Set by the authenticated Gateway, never parsed from an untrusted target string. */
export interface ComputerAttachContext { workspaceId?: string }
export type ComputerNotice =
  | { type: 'computer.acting'; computerId: string; engine: string; active: boolean; action: ComputerAction['action'] }
  | { type: 'computer.lease'; computerId: string; holder: LeaseHolder }
  | { type: 'computer.kill'; engaged: boolean }
  | { type: 'computer.action'; computerId: string; providerId: string; engine: string; targetId: string; action: ComputerAction['action']; outcome: 'allowed' | 'denied' | 'failed' };

export interface ComputerInfo {
  id: string;
  providerId: string;
  capabilities: ComputerCapabilities;
  holder: LeaseHolder;
  assignments: { engine: string; targetId: string }[];
}
export interface ComputerBinding { endpoint: string; token: string; computerId: string }

interface Entry { providerId: string; provider: ComputerProvider; computer: Computer; holder: LeaseHolder; policy: ComputerSafetyPolicy; queue: Promise<unknown>; workspaceId?: string }
interface Assignment { engine: string; targetId: string; computerId: string; token: string }

export class ComputerRegistry {
  private readonly providers = new Map<string, ComputerProvider>();
  private readonly entries = new Map<string, Entry>();
  private readonly attaching = new Set<string>();
  private readonly releasing = new Set<string>();
  private readonly assignments = new Map<string, Assignment>();
  private readonly tokens = new Map<string, Assignment>();
  private killed = false;
  private readonly killedWorkspaces = new Map<string, boolean>();

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

  list(workspaceId?: string): ComputerInfo[] {
    return [...this.entries].filter(([, entry]) => workspaceId === undefined || !entry.workspaceId || entry.workspaceId === workspaceId).map(([id, entry]) => ({
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
      this.entries.set(target, { providerId, provider, computer, holder: 'agent', workspaceId: context?.workspaceId, policy: { allowDestructiveKeys: false, navigationOrigins: [] }, queue: Promise.resolve() });
      return this.list().find((entry) => entry.id === target)!;
    } finally {
      this.attaching.delete(target);
    }
  }

  async provision(providerId: string, spec: Record<string, unknown>, context?: ComputerAttachContext): Promise<ComputerInfo> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error('Computer provider is unavailable');
    const id = `neo-${randomBytes(12).toString('hex')}`;
    this.attaching.add(id);
    try {
      const computer = await provider.provision({ ...spec, id }, context);
      if (this.providers.get(providerId) !== provider) {
        await provider.release(id);
        throw new Error('Computer provider was disabled');
      }
      this.entries.set(id, { providerId, provider, computer, holder: 'agent', workspaceId: context?.workspaceId, policy: { allowDestructiveKeys: false, navigationOrigins: [] }, queue: Promise.resolve() });
      return this.list().find((entry) => entry.id === id)!;
    } finally {
      this.attaching.delete(id);
    }
  }

  async release(id: string): Promise<boolean> {
    return this.remove(id, false);
  }

  async terminate(id: string): Promise<boolean> {
    return this.remove(id, true);
  }

  private async remove(id: string, force: boolean): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.releasing.add(id);
    this.entries.delete(id);
    for (const [key, assignment] of this.assignments) {
      if (assignment.computerId === id) this.revoke(key);
    }
    try {
      await entry.queue.catch(() => {});
      if (force && entry.provider.terminate) await entry.provider.terminate(id);
      else await entry.provider.release(id);
      return true;
    } finally {
      this.releasing.delete(id);
    }
  }

  private key(engine: string, targetId: string): string { return JSON.stringify([engine, targetId]); }

  assertWorkspace(id: string, workspaceId: string): void {
    const entry = this.entries.get(id);
    if (entry?.workspaceId && entry.workspaceId !== workspaceId) throw new Error('Computer workspace mismatch');
  }

  assign(engine: 'hermes' | 'dsh' | 'superagent', targetId: string, computerId: string): ComputerBinding {
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

  kill(engaged: boolean, workspaceId?: string): { engaged: boolean } {
    if (workspaceId) this.killedWorkspaces.set(workspaceId, engaged);
    else this.killed = engaged;
    for (const entry of this.entries.values()) {
      if (workspaceId && entry.workspaceId !== workspaceId) continue;
      if (engaged) entry.computer.interrupt?.();
      else if (entry.holder === 'agent' && !this.killed && !this.killedWorkspaces.get(entry.workspaceId ?? '')) entry.computer.resumeInput?.();
    }
    this.publish({ type: 'computer.kill', engaged });
    return { engaged };
  }

  state(workspaceId?: string): { engaged: boolean } {
    return { engaged: this.killed || Boolean(workspaceId && this.killedWorkspaces.get(workspaceId)) };
  }

  async capture(id: string): Promise<Capture> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Unknown computer');
    return this.runQueued(entry, () => Promise.resolve(entry.computer.capture()));
  }

  async lease(id: string, holder: LeaseHolder): Promise<ComputerInfo> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Unknown computer');
    // Human takeover preempts active native input before queued agent work drains.
    if (holder === 'human') {
      entry.holder = 'human';
      entry.computer.interrupt?.();
    }
    await this.runQueued(entry, async () => {
      await entry.computer.lease(holder);
      entry.holder = holder;
      if (this.state(entry.workspaceId).engaged && holder === 'agent') entry.computer.interrupt?.();
      this.publish({ type: 'computer.lease', computerId: id, holder });
    });
    return this.list().find((computer) => computer.id === id)!;
  }

  private runQueued<T>(entry: Entry, operation: () => Promise<T>): Promise<T> {
    const running = entry.queue.then(operation, operation);
    entry.queue = running.catch(() => {});
    return running;
  }

  policy(id: string): ComputerSafetyPolicy {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Unknown computer');
    return structuredClone(entry.policy);
  }

  setPolicy(id: string, policy: ComputerSafetyPolicy): ComputerSafetyPolicy {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Unknown computer');
    const origins = policy.navigationOrigins.map((origin) => {
      const url = new URL(origin);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.origin !== origin) {
        throw new Error('Navigation policy requires exact HTTP(S) origins');
      }
      return url.origin;
    });
    entry.policy = { allowDestructiveKeys: policy.allowDestructiveKeys === true, navigationOrigins: origins };
    return this.policy(id);
  }

  async act(token: string, action: ComputerAction, authorized: () => boolean = () => true): Promise<{ ok: true; capture?: Capture; lease?: { holder: LeaseHolder; engaged: boolean } }> {
    const assignment = this.tokens.get(token);
    const entry = assignment && this.entries.get(assignment.computerId);
    const audit = (outcome: 'allowed' | 'denied' | 'failed') => this.publish({
      type: 'computer.action', computerId: assignment?.computerId ?? 'unassigned', providerId: entry?.providerId ?? 'unknown',
      engine: assignment?.engine ?? 'unknown', targetId: assignment?.targetId ?? 'unknown', action: action.action, outcome,
    });
    if (!assignment || !entry) { audit('denied'); throw new Error('Computer capability denied'); }
    return this.runQueued(entry, async () => {
      let executing = false;
      try {
        if (!authorized()) throw new Error('Computer capability revoked');
        if (this.tokens.get(token) !== assignment) throw new Error('Computer capability revoked');
        if (action.action === 'status') {
          audit('allowed'); return { ok: true, lease: { holder: entry.holder, engaged: this.state(entry.workspaceId).engaged } };
        }
        if (this.state(entry.workspaceId).engaged) throw new Error('Computer kill switch engaged');
        if (entry.holder === 'human') throw new Error('Computer is leased to a human');
        // Unknown chords and editing/deletion keys require explicit operator policy.
        // Allow only single letters/digits and a small set of non-destructive keys by default.
        if (action.action === 'key' && !entry.policy.allowDestructiveKeys
          && !/^(?:[a-z0-9]|enter|return|tab|esc|escape|space|left|right|up|down|arrowleft|arrowright|arrowup|arrowdown|home|end|pageup|pagedown)$/i.test(action.keys.trim())) {
          throw new Error('Key blocked by computer safety policy');
        }
        if (action.action === 'navigate') {
          const url = new URL(action.url);
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
            || !entry.policy.navigationOrigins.includes(url.origin)) throw new Error('Navigation blocked by computer safety policy');
          if (!entry.computer.navigate) throw new Error('Computer does not support navigation');
        }
        executing = true;
        this.publish({ type: 'computer.acting', computerId: assignment.computerId, engine: assignment.engine,
          active: true, action: action.action });
        if (action.action === 'capture') {
          const capture = await entry.computer.capture(); audit('allowed'); return { ok: true, capture };
        }
        if (action.action === 'navigate') await entry.computer.navigate!(action.url);
        else await entry.computer.input(action);
        audit('allowed'); return { ok: true };
      } catch (error) { audit(executing ? 'failed' : 'denied'); throw error; }
      finally {
        if (executing) this.publish({ type: 'computer.acting', computerId: assignment.computerId, engine: assignment.engine,
          active: false, action: action.action });
      }
    });
  }
}
