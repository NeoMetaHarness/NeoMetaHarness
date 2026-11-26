import { randomBytes } from 'node:crypto';
import type { Capture, Computer, ComputerAttachContext, ComputerProvider } from '@neometaharness/computers';
import type { VaultService } from '@neometaharness/vault';
import sharp from 'sharp';
import WebSocket from 'ws';

export interface HermesScreenBridge {
  connect(profile: string, workspaceId: string, token: string): Promise<{ url: string; sessionToken: string }>;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

/** Hermes v0.23.2, tui_gateway/methods_display.py:50,60, chat_ws.py:650.
 * The dashboard's existing authenticated, profile-scoped JSON-RPC surface is read-only here.
 */
class HermesScreenSocket {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  private constructor(private readonly socket: WebSocket, private readonly profile: string) {
    socket.on('message', data => {
      let response: { id?: number; result?: unknown; error?: unknown };
      try { response = JSON.parse(data.toString()) as typeof response; }
      catch { return; }
      const waiting = this.pending.get(response.id ?? -1);
      if (!waiting) return;
      clearTimeout(waiting.timeout);
      this.pending.delete(response.id!);
      if (response.error) waiting.reject(new Error('Hermes screen RPC failed'));
      else waiting.resolve(response.result);
    });
    socket.on('error', () => this.fail());
    socket.on('close', () => this.fail());
  }

  static async open(connection: { url: string; sessionToken: string }, profile: string): Promise<HermesScreenSocket> {
    const address = new URL(connection.url);
    if (address.protocol !== 'ws:' || address.hostname !== '127.0.0.1'
      || address.pathname !== '/api/ws' || address.username || address.password) {
      throw new Error('Hermes screen endpoint must be loopback');
    }
    address.searchParams.set('token', connection.sessionToken);
    const ws = new WebSocket(address, { handshakeTimeout: 5000, maxPayload: 10_000_000 });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Hermes screen connection timed out')), 5000);
        ws.once('open', () => { clearTimeout(timer); resolve(); });
        ws.once('error', () => { clearTimeout(timer); reject(new Error('Hermes screen unavailable')); });
      });
      const client = new HermesScreenSocket(ws, profile);
      await client.request('display.status');
      return client;
    } catch {
      ws.terminate();
      throw new Error('Hermes bot screen is unavailable');
    }
  }

  request(method: 'display.status' | 'display.thumbnail'): Promise<unknown> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Hermes screen disconnected'));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Hermes screen request timed out'));
      }, 5000);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: { profile: this.profile } }), error => {
        if (!error) return;
        const waiting = this.pending.get(id);
        if (!waiting) return;
        clearTimeout(waiting.timeout);
        this.pending.delete(id);
        reject(new Error('Hermes screen send failed'));
      });
    });
  }

  private fail(): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error('Hermes screen disconnected'));
    }
    this.pending.clear();
  }

  close(): void { this.fail(); this.socket.terminate(); }

  async capture(): Promise<Capture> {
    const data = await this.request('display.thumbnail') as { data_url?: unknown; suppressed?: string } | null;
    if (!data || typeof data.data_url !== 'string') {
      throw new Error('Hermes bot screen stopped or held by a human');
    }
    const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(data.data_url);
    if (!match || match[1].length > 9_000_000) throw new Error('Invalid Hermes screen frame');
    const jpeg = Buffer.from(match[1], 'base64');
    const info = await sharp(jpeg, { limitInputPixels: 16_777_216 }).metadata();
    if (!info.width || !info.height || info.width > 8192 || info.height > 8192) {
      throw new Error('Invalid Hermes screen dimensions');
    }
    return { png: (await sharp(jpeg).png().toBuffer()).toString('base64'), width: info.width, height: info.height };
  }
}

export class HermesScreenProvider implements ComputerProvider {
  readonly capabilities = { screen: true, input: false, browserCdp: false, shell: false, files: false, snapshot: false };
  private readonly sessions = new Map<string, HermesScreenSocket>();
  private readonly attaching = new Set<string>();
  private disabled = false;

  constructor(
    private readonly vault: Pick<VaultService, 'get' | 'put'>,
    private readonly bridge: () => HermesScreenBridge | undefined,
  ) {}

  provision(): never { throw new Error('Hermes screens belong to running bots'); }

  async attach(target: string, context?: ComputerAttachContext): Promise<Computer> {
    if (this.disabled) throw new Error('Hermes screen provider disabled');
    const profile = /^hermes-screen:([a-z][a-z0-9_-]{0,47})$/.exec(target)?.[1];
    if (!profile || !isHermesProfileReference(profile) || !context?.workspaceId) {
      throw new Error('Hermes profile and authenticated workspace required');
    }
    if (this.sessions.has(target) || this.attaching.has(target)) throw new Error('Hermes screen already attached');
    const bridge = this.bridge();
    if (!bridge) throw new Error('Hermes is disabled');
    this.attaching.add(target);
    let socket: HermesScreenSocket | undefined;
    try {
      const scope = { kind: 'engine' as const, workspaceId: context.workspaceId, subjectId: `engine-hermes/${profile}` };
      let token = await this.vault.get(scope, 'NEO_SCREEN_VIEW_TOKEN');
      if (!token) {
        token = randomBytes(32).toString('hex');
        await this.vault.put(scope, 'NEO_SCREEN_VIEW_TOKEN', token);
      }
      const connection = await bridge.connect(profile, context.workspaceId, token);
      socket = await HermesScreenSocket.open(connection, profile);
      if (this.disabled) throw new Error('Hermes screen provider disabled');
      this.sessions.set(target, socket);
      return {
        screen: () => ({ protocol: 'png' }),
        capture: () => socket!.capture(),
        lease: () => {},
        input: () => { throw new Error('Hermes screen is read-only'); },
        interrupt: () => {},
      };
    } catch (error) {
      socket?.close();
      throw error;
    } finally {
      this.attaching.delete(target);
    }
  }

  release(id: string): void {
    this.sessions.get(id)?.close();
    this.sessions.delete(id);
  }

  close(): void {
    this.disabled = true;
    for (const id of this.sessions.keys()) this.release(id);
  }
}
import { isHermesProfileReference } from '@neometaharness/contracts';
