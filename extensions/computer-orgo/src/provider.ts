import type { Capture, Computer, ComputerAttachContext, ComputerInput, ComputerProvider, LeaseHolder } from '@neometaharness/computers';
import type { VaultService } from '@neometaharness/vault';
import { createEgressFetch } from '@neometaharness/egress';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const managedId = /^neo-[a-f0-9]{24}$/;
// The provider owns this ledger. An individual workspace cannot claim a VM by saving its ID in settings.
const ownershipScope = { kind: 'engine' as const, workspaceId: 'default', subjectId: 'computer-orgo-ownership' };
const ownershipName = (remoteId: string) => 'COMPUTER_' + remoteId.replace(/-/g, '_').toUpperCase();

export interface OrgoClient {
  request<T>(key: string, method: 'GET' | 'POST' | 'DELETE', path: string, body?: object, signal?: AbortSignal): Promise<T>;
}

/** Custom endpoints require explicit operator configuration and are validated for every request. */
export class HttpOrgoClient implements OrgoClient {
  private readonly transport: typeof fetch;
  constructor(private readonly origin = 'https://www.orgo.ai/api', injectedClient?: typeof fetch,
    allowPrivateNetwork = false) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.pathname !== '/api' || url.search || url.hash || url.username || url.password) {
      throw new Error('Invalid Orgo API origin');
    }
    this.transport = createEgressFetch(() => allowPrivateNetwork, injectedClient);
  }

  async request<T>(key: string, method: 'GET' | 'POST' | 'DELETE', path: string, body?: object, signal?: AbortSignal): Promise<T> {
    if (!/^\/computers(?:\/[0-9a-f-]{36})?(?:\/[a-z-]+)?(?:\?[a-z0-9=&_]+)?$/.test(path)) throw new Error('Invalid Orgo path');
    try {
      const response = await this.transport(this.origin + path, {
        method, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('Orgo API request failed (' + response.status + ')');
      if (response.status === 204) return {} as T;
      return await response.json() as T;
    } catch (error) {
      // Never expose provider response bodies, API keys or network exception text.
      if (error instanceof Error && /^Orgo API request failed \(\d+\)$/.test(error.message)) throw error;
      throw new Error('Orgo API request failed');
    }
  }
}

type Remote = { id: string; workspace_id?: string; project_id?: string; os?: string };
type Shot = { success: boolean; image: string; width: number; height: number };
type Instance = { remoteId: string; owned: boolean; workspaceId: string; computer: OrgoComputer };

class OrgoComputer implements Computer {
  private holder: LeaseHolder = 'agent';
  private blocked = false;
  private pending = new Set<AbortController>();

  constructor(private readonly api: OrgoClient, private readonly key: () => Promise<string>,
    private readonly remoteId: string, private readonly os: string) {}

  screen() { return { protocol: 'png' as const }; }
  lease(holder: LeaseHolder): void {
    this.holder = holder;
    if (holder === 'human') this.interrupt();
    else this.resumeInput();
  }
  interrupt(): void {
    this.blocked = true;
    for (const controller of this.pending) controller.abort();
  }
  resumeInput(): void { if (this.holder === 'agent') this.blocked = false; }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: object, input = false): Promise<T> {
    if (input && (this.blocked || this.holder === 'human')) throw new Error('Orgo input unavailable');
    const controller = new AbortController();
    if (input) this.pending.add(controller);
    try {
      const key = await this.key();
      if (input && (this.blocked || this.holder === 'human')) throw new Error('Orgo input unavailable');
      return await this.api.request<T>(key, method, '/computers/' + this.remoteId + '/' + path, body, controller.signal);
    } finally { this.pending.delete(controller); }
  }

  async input(action: ComputerInput): Promise<void> {
    if (action.action === 'click') await this.request('POST', 'click', { x: action.x, y: action.y }, true);
    else if (action.action === 'move') await this.request('POST', 'mouse-move', { x: action.x, y: action.y }, true);
    else if (action.action === 'type') await this.request('POST', 'type', { text: action.text }, true);
    else if (action.action === 'key') await this.request('POST', 'key', { key: action.keys }, true);
    else {
      if (!['up', 'down'].includes(action.direction) || !Number.isInteger(action.amount) ||
          action.amount < 1 || action.amount > 50) throw new Error('Invalid Orgo scroll');
      const position = this.os === 'windows' ? {} : { x: 640, y: 400 };
      await this.request('POST', 'scroll',
        { ...position, direction: action.direction, amount: action.amount }, true);
    }
  }

  async capture(): Promise<Capture> {
    const shot = await this.request<Shot>('GET', 'screenshot?response_format=base64&format=png');
    if (shot.success !== true || typeof shot.image !== 'string' ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(shot.image) ||
        !Number.isInteger(shot.width) || shot.width <= 0 ||
        !Number.isInteger(shot.height) || shot.height <= 0) throw new Error('Invalid Orgo screenshot');
    return { png: shot.image, width: shot.width, height: shot.height };
  }
}

export class OrgoComputerProvider implements ComputerProvider {
  readonly capabilities = { screen: true, input: true, browserCdp: false, shell: false, files: false, snapshot: false };
  private instances = new Map<string, Instance>();
  private pending = new Set<Promise<Computer>>();
  private disposed = false;

  constructor(private readonly vault: Pick<VaultService, 'get' | 'put' | 'delete'>,
    private readonly settingsFor: (workspaceId: string) => Promise<Record<string, unknown>>,
    private readonly api: OrgoClient = new HttpOrgoClient()) {}

  private async key(workspaceId: string): Promise<string> {
    const key = (await this.settingsFor(workspaceId)).apiKey;
    if (typeof key !== 'string' || !key) throw new Error('Orgo API key missing from extension settings');
    return key;
  }
  private async workspace(context?: ComputerAttachContext): Promise<{ neoId: string; orgoId: string }> {
    if (!context?.workspaceId) throw new Error('Authenticated workspace required');
    const orgoId = (await this.settingsFor(context.workspaceId)).workspaceId;
    if (typeof orgoId !== 'string' || !uuid.test(orgoId)) throw new Error('Orgo workspace ID missing from extension settings');
    return { neoId: context.workspaceId, orgoId };
  }

  provision(spec: Record<string, unknown>, context?: ComputerAttachContext): Promise<Computer> {
    if (this.disposed) throw new Error('Orgo provider disabled');
    if (typeof spec.id !== 'string' || !managedId.test(spec.id)) throw new Error('Invalid managed computer ID');
    const os = spec.os ?? 'linux', ram = spec.ram ?? (os === 'macos' ? undefined : 4), cpu = spec.cpu ?? 1;
    const validRam = os === 'macos' ? (ram === undefined || ram === 10) : [4, 8, 16, 32, 64].includes(ram as number);
    if (!['linux', 'windows', 'macos'].includes(String(os)) || !validRam ||
        ![1, 2, 4, 6, 8].includes(cpu as number)) throw new Error('Invalid Orgo computer size');
    const operation = this.workspace(context).then(({ neoId, orgoId }) =>
      this.create(spec.id as string, neoId, orgoId, String(os), ram as number | undefined, Number(cpu)));
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => {});
    return operation;
  }

  private async create(id: string, neoId: string, orgoId: string, os: string, ram: number | undefined, cpu: number): Promise<Computer> {
    const remote = await this.api.request<Remote>(await this.key(neoId), 'POST', '/computers',
      { workspace_id: orgoId, name: id, os, ...(ram === undefined ? {} : { ram }), cpu });
    if (!uuid.test(remote.id) || remote.workspace_id !== orgoId) throw new Error('Invalid Orgo create response');
    if (this.disposed) {
      await this.api.request(await this.key(neoId), 'DELETE', '/computers/' + remote.id).catch(() => {});
      throw new Error('Orgo provider disabled');
    }
    try { await this.vault.put(ownershipScope, ownershipName(remote.id), neoId); }
    catch (error) {
      await this.api.request(await this.key(neoId), 'DELETE', '/computers/' + remote.id).catch(() => {});
      throw error;
    }
    const computer = new OrgoComputer(this.api, () => this.key(neoId), remote.id, os);
    this.instances.set(id, { remoteId: remote.id, owned: true, workspaceId: neoId, computer });
    return computer;
  }

  async attach(target: string, context?: ComputerAttachContext): Promise<Computer> {
    if (this.disposed) throw new Error('Orgo provider disabled');
    if (!uuid.test(target)) throw new Error('Invalid Orgo computer ID');
    const { neoId, orgoId } = await this.workspace(context);
    if (await this.vault.get(ownershipScope, ownershipName(target)) !== neoId) throw new Error('Orgo computer workspace mismatch');
    const remote = await this.api.request<Remote>(await this.key(neoId), 'GET', '/computers/' + target);
    if (remote.id !== target || (remote.project_id ?? remote.workspace_id) !== orgoId) throw new Error('Orgo computer workspace mismatch');
    if (this.disposed) throw new Error('Orgo provider disabled');
    const computer = new OrgoComputer(this.api, () => this.key(neoId), target, remote.os ?? 'linux');
    this.instances.set(target, { remoteId: target, owned: false, workspaceId: neoId, computer });
    return computer;
  }

  async release(id: string): Promise<void> { await this.cleanup(id, false); }
  async terminate(id: string): Promise<void> { await this.cleanup(id, true); }
  private async cleanup(id: string, destroy: boolean): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance) return;
    instance.computer.interrupt();
    if (destroy || instance.owned) {
      await this.api.request(await this.key(instance.workspaceId), destroy ? 'DELETE' : 'POST',
        '/computers/' + instance.remoteId + (destroy ? '' : '/stop'));
    }
    if (destroy) await this.vault.delete(ownershipScope, ownershipName(instance.remoteId));
    this.instances.delete(id);
  }

  async close(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.pending]);
    await Promise.allSettled([...this.instances.keys()].map(id => this.release(id)));
  }
}
