import { randomUUID } from 'node:crypto';
import type { Capture, Computer, ComputerAttachContext, ComputerInput, ComputerProvider, LeaseHolder } from '@neometaharness/computers';
import { approveHttpsEgress, systemEgressResolver, type EgressResolver } from '@neometaharness/kernel';
import { Agent } from 'undici';

export interface BoatSettings { baseUrl?: string; apiKey?: string; allowPrivateNetwork?: boolean }
export type BoatHttp = (url: string, init: RequestInit) => Promise<Response>;
type Instance = { sandboxId: string; workspaceId: string; url: string; key: string; blocked: boolean; dispatcher?: Agent; current?: AbortController };
const managedId = /^neo-[0-9a-f]{24}$/;
const sandboxId = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const sizes = new Set(['small', 'default', 'large', 'xlarge']);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Encode an argument-only Python program so input text never becomes shell syntax. */
function pythonCommand(program: string): string {
  return `python3 -c "import base64;exec(base64.b64decode('${Buffer.from(program).toString('base64')}'))"`;
}

function actionProgram(action: ComputerInput): string {
  const args = (() => {
    switch (action.action) {
      case 'click': return ['mousemove', String(action.x), String(action.y), 'click', '1'];
      case 'move': return ['mousemove', String(action.x), String(action.y)];
      case 'type': return ['type', '--clearmodifiers', '--', action.text];
      case 'key': return ['key', '--clearmodifiers', action.keys];
      case 'scroll': return ['click', '--repeat', String(action.amount), action.direction === 'up' ? '4' : '5'];
    }
  })();
  if ((action.action === 'click' || action.action === 'move') &&
      (!Number.isInteger(action.x) || !Number.isInteger(action.y) || action.x < 0 || action.y < 0)) {
    throw new Error('Invalid pointer coordinates');
  }
  if (action.action === 'scroll' && (!['up', 'down'].includes(action.direction) || !Number.isInteger(action.amount) || action.amount < 1 || action.amount > 100)) {
    throw new Error('Invalid scroll input');
  }
  return pythonCommand(`import subprocess\nsubprocess.run(${JSON.stringify(['xdotool', ...args])}, check=True)`);
}

/** Boat REST adapter. Safety, assignment, human lease, kill and audit run in ComputerRegistry. */
export class BoatComputerProvider implements ComputerProvider {
  readonly capabilities = { screen: true, input: true, browserCdp: false, shell: false, files: false, snapshot: true };
  private readonly instances = new Map<string, Instance>();
  private disposed = false;

  constructor(
    private readonly settings: () => BoatSettings,
    private readonly http: BoatHttp = fetch,
    private readonly resolveHost: EgressResolver = systemEgressResolver,
  ) {}

  attach(): never { throw new Error('Boat computers must be created through computers.provision'); }

  private async request<T>(instance: Instance, method: string, path: string, body?: object, signal?: AbortSignal, idempotency?: string): Promise<T> {
    const request: RequestInit = {
      method,
      redirect: 'error',
      headers: { Authorization: `Bearer ${instance.key}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(idempotency ? { 'Idempotency-Key': idempotency } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    };
    // Production TLS keeps the original hostname for certificate validation and pins the vetted DNS answer.
    const options = instance.dispatcher ? { ...request, dispatcher: instance.dispatcher } as unknown as RequestInit : request;
    const response = await this.http(instance.url + path, options);
    if (!response.ok) throw new Error(`Boat API ${method} ${path.split('?')[0]} returned HTTP ${response.status}`);
    return await response.json() as T;
  }

  async provision(spec: Record<string, unknown>, context?: ComputerAttachContext): Promise<Computer> {
    if (this.disposed) throw new Error('Boat provider disabled');
    if (!context?.workspaceId || typeof spec.id !== 'string' || !managedId.test(spec.id)) throw new Error('Authenticated managed computer required');
    const config = this.settings();
    if (!config.apiKey || typeof config.apiKey !== 'string') throw new Error('Boat API key must be configured in extension settings');
    const endpoint = await approveHttpsEgress(config.baseUrl ?? 'https://boat.dev/api/v1',
      config.allowPrivateNetwork === true, this.resolveHost);
    const instance: Instance = { sandboxId: '', workspaceId: context.workspaceId, url: endpoint.url,
      key: config.apiKey, blocked: false };
    if (this.http === fetch) {
      instance.dispatcher = new Agent({ connect: {
        lookup: (_hostname, _options, callback) => callback(null, endpoint.address, endpoint.family),
      } });
    }
    const options: Record<string, unknown> = { labels: { 'neo-computer': spec.id } };
    if (spec.type !== undefined) {
      if (typeof spec.type !== 'string' || !sizes.has(spec.type)) throw new Error('Invalid Boat sandbox size');
      options.type = spec.type;
    }
    if (spec.ttlSeconds !== undefined) {
      if (!Number.isInteger(spec.ttlSeconds) || Number(spec.ttlSeconds) < 1 || Number(spec.ttlSeconds) > 2_592_000) throw new Error('Invalid Boat TTL');
      options.ttlSeconds = spec.ttlSeconds;
    }
    const source = typeof spec.forkOf === 'string' ? this.instances.get(spec.forkOf) : undefined;
    if (spec.forkOf !== undefined && (!source || source.workspaceId !== context.workspaceId || source.url !== endpoint.url)) {
      throw new Error('Boat fork source must be a managed computer in the same workspace and API');
    }
    const path = source ? `/sandboxes/${source.sandboxId}/fork` : '/sandboxes';
    let response: { sandbox?: { id?: string }; id?: string };
    try { response = await this.request(instance, 'POST', path, options, undefined, spec.id); }
    catch (error) { await instance.dispatcher?.close(); throw error; }
    const remote = response.sandbox?.id ?? response.id;
    if (!remote || !sandboxId.test(remote)) {
      await instance.dispatcher?.close();
      throw new Error('Boat returned invalid sandbox ID');
    }
    instance.sandboxId = remote;
    if (this.disposed) { await this.request(instance, 'DELETE', `/sandboxes/${remote}`).catch(() => {}); throw new Error('Boat provider disabled'); }
    this.instances.set(spec.id, instance);
    return this.computer(instance);
  }

  private computer(instance: Instance): Computer {
    const path = `/sandboxes/${instance.sandboxId}`;
    const command = async (value: string, signal?: AbortSignal): Promise<string> => {
      const result = await this.request<{ success: boolean; exitCode: number | null; stdout: string; stderr?: string; stdoutTruncated?: boolean }>(
        instance, 'POST', `${path}/commands`, { command: value, timeoutSeconds: 30 }, signal,
      );
      if (!result.success || result.exitCode !== 0 || result.stdoutTruncated) throw new Error('Boat computer command failed or output was truncated');
      return result.stdout;
    };
    return {
      screen: async () => {
        const result = await this.request<{ desktopUrl?: string; provisioning?: boolean }>(instance, 'POST', `${path}/desktop`);
        if (result.provisioning || !result.desktopUrl) throw new Error('Boat desktop is still provisioning');
        // This is a bearer-capability WebRTC URL. Only the internal viewer consumes screen(); never publish it on a route.
        return { protocol: 'webrtc', url: result.desktopUrl };
      },
      lease: (holder: LeaseHolder) => { instance.blocked = holder === 'human'; if (instance.blocked) instance.current?.abort(); },
      interrupt: () => { instance.blocked = true; instance.current?.abort(); },
      resumeInput: () => { instance.blocked = false; },
      input: async (action: ComputerInput) => {
        if (this.disposed || instance.blocked) throw new Error('Boat input interrupted');
        const current = new AbortController();
        instance.current = current;
        try { await command(actionProgram(action), current.signal); }
        finally { if (instance.current === current) instance.current = undefined; }
      },
      capture: async (): Promise<Capture> => {
        // Boat does not publish a screenshot REST endpoint. Capture the Linux X11 root using its command API.
        const program = "import base64,subprocess\ndata=subprocess.check_output(['import','-window','root','png:-'])\nprint(base64.b64encode(data).decode())";
        const png = Buffer.from((await command(pythonCommand(program))).trim(), 'base64');
        if (png.length < 24 || !png.subarray(0, 8).equals(pngSignature)) throw new Error('Boat returned an invalid PNG');
        const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
        if (!width || !height || width > 8192 || height > 8192) throw new Error('Boat returned invalid screen dimensions');
        return { png: png.toString('base64'), width, height };
      },
      snapshot: () => this.request(instance, 'GET', `${path}/snapshots/latest`),
    };
  }

  async saveSnapshot(id: string, workspaceId: string): Promise<unknown> {
    const instance = this.instances.get(id);
    if (!workspaceId || !instance || instance.workspaceId !== workspaceId || this.disposed) {
      throw new Error('Unknown Boat computer in workspace');
    }
    const name = `neo-${randomUUID()}`;
    return this.request(instance, 'POST', '/saved-snapshots', { sandboxId: instance.sandboxId, name });
  }

  private async cleanup(id: string, force: boolean): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance) return;
    instance.blocked = true;
    instance.current?.abort();
    this.instances.delete(id);
    // Stop saves a snapshot for an affordable handover. Kill permanently deletes the sandbox.
    try { await this.request(instance, force ? 'DELETE' : 'POST', `/sandboxes/${instance.sandboxId}${force ? '' : '/stop'}`); }
    finally { await instance.dispatcher?.close(); }
  }
  release(id: string): Promise<void> { return this.cleanup(id, false); }
  terminate(id: string): Promise<void> { return this.cleanup(id, true); }
  async close(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.instances.keys()].map(id => this.release(id)));
  }
}
