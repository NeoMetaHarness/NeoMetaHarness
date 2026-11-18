import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { DshEvent } from '@neometaharness/contracts';
import { DshProjector, type VaultService } from '@neometaharness/vault';
import type { ComputerRegistry } from '@neometaharness/computers';
import type { SkillsBridge } from '@neometaharness/kernel';
import type { DshMemoryBridge } from './memory.js';

const extensionRoot = fileURLToPath(new URL('../', import.meta.url));
const cli = join(extensionRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const credentialKeys = ['DEEPSEEK_API_KEY', 'DSH_CONFIG_PATH'] as const;
const modelKeys = ['NEO_MODEL_BASE_URL', 'NEO_MODEL_NAME', 'NEO_MODEL_API_KEY'] as const;
type ModelRole = 'default' | 'fast' | 'reasoning' | 'coding' | 'eval';
export interface ModelResolver {
  active: boolean;
  resolve(role: ModelRole, profile?: string): Promise<{ model: string; baseUrl: string; apiKey?: string }>;
}

interface PendingCall {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

async function stopTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    await new Promise<void>((done) => execFile(join(systemRoot, 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error) => {
        if (error) child.kill('SIGKILL');
        done();
      }));
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

class Session {
  readonly id: string;
  readonly pid: number;
  private nextRequest = 0;
  private sequence = 0;
  private stopped = false;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingCall>();
  private readonly events: DshEvent[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly exited: Promise<void>;
  private diagnostics = '';
  private lastMessageId = '';
  private stopPromise?: Promise<void>;

  constructor(id: string, readonly stateDir: string, private readonly cwd: string, env: Record<string, string>, patch: string,
    private readonly model?: string) {
    this.id = id;
    this.child = spawn(process.execPath, [cli, '--profile', 'sdk', '--patch', patch], {
      cwd: extensionRoot,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pid = this.child.pid ?? 0;
    this.exited = new Promise<void>((done) => {
      const terminate = (cause: Error) => {
        this.stopped = true;
        for (const call of this.pending.values()) {
          clearTimeout(call.timer);
          call.reject(cause);
        }
        this.pending.clear();
        this.notify();
        done();
      };
      this.child.once('error', (error) => terminate(error));
      this.child.once('exit', (code) => terminate(new Error(`DSH exited ${code}: ${this.diagnostics.slice(-1000)}`)));
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.diagnostics = (this.diagnostics + chunk.toString()).slice(-4000);
    });
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined) {
        const call = this.pending.get(message.id);
        if (!call) return;
        this.pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.error) call.reject(new Error(JSON.stringify(message.error)));
        else call.resolve(message.result);
      } else if (message.method === 'session.event' && message.params?.sessionId === this.id) {
        const event = message.params.event;
        if (!event) return;
        const messageId = String(event.data?.message?.id ?? event.id ?? event.messageId ?? this.lastMessageId);
        if (event.type === 'assistant/message') {
          for (const block of event.data?.stream ?? event.stream ?? []) {
            if (block.type !== 'text-chunks') continue;
            for (const text of block.texts ?? []) {
              this.publish({ kind: 'text.delta', messageId, textDelta: String(text) });
            }
          }
        }
        this.publish({ kind: 'event', type: event.type, payload: event });
      } else if (message.method === 'session.status' && message.params?.sessionId === this.id) {
        this.publish({ kind: 'event', type: 'session.status', payload: { status: message.params.status } });
      }
    });
  }

  private notify(): void { for (const listener of this.listeners) listener(); }

  private publish(event: DshEvent): void {
    this.events.push({ ...event, sequence: ++this.sequence });
    this.notify();
  }

  private rpc(method: string, params?: object, timeoutMs = 45000): Promise<any> {
    if (this.stopped) return Promise.reject(new Error('DSH session is stopped'));
    const id = ++this.nextRequest;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new Error(`DSH ${method} timed out: ${this.diagnostics.slice(-1000)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n',
        (error) => {
          if (!error) return;
          const call = this.pending.get(id);
          if (call) {
            this.pending.delete(id);
            clearTimeout(call.timer);
            call.reject(error);
          }
        });
    });
  }

  async initialize(): Promise<void> {
    const response = await this.rpc('initialize', { cwd: this.cwd,
      provider: this.model ? 'neo-model-hub' : 'neo-scripted', model: this.model ?? 'scripted' });
    if (response?.serverInfo?.name !== 'deepseek-harness-sdk-runtime') {
      throw new Error('Unexpected DSH SDK initialize response');
    }
  }

  async prompt(text: string): Promise<{ messageId: string }> {
    const response = await this.rpc('session/prompt', {
      sessionId: this.id, contentBlocks: [{ type: 'text', text }],
    });
    this.lastMessageId = String(response.messageId);
    return { messageId: this.lastMessageId };
  }

  async wait(): Promise<{ status: 'settled' }> {
    await this.rpc('session/wait', { sessionId: this.id });
    this.publish({ kind: 'event', type: 'session.settled', payload: { sessionId: this.id } });
    return { status: 'settled' };
  }

  async *subscribe(signal?: AbortSignal): AsyncGenerator<DshEvent> {
    let index = 0;
    let wake: (() => void) | undefined;
    const notify = () => wake?.();
    this.listeners.add(notify);
    signal?.addEventListener('abort', notify);
    try {
      yield { kind: 'snapshot', sequence: 0, payload: { sessionId: this.id, pid: this.pid } };
      while (!signal?.aborted) {
        if (index < this.events.length) {
          const event = this.events[index++]!;
          yield event;
          if (event.type === 'session.settled') return;
          continue;
        }
        if (this.stopped) return;
        await new Promise<void>((done) => { wake = done; });
        wake = undefined;
      }
    } finally {
      this.listeners.delete(notify);
      signal?.removeEventListener('abort', notify);
    }
  }

  async stop(force = false): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      if (!force && !this.stopped) {
        await this.rpc('shutdown', undefined, 3000).catch(() => {});
        this.child.stdin.end();
        await Promise.race([this.exited, new Promise((done) => setTimeout(done, 1500))]);
      }
      await stopTree(this.child);
      await Promise.race([this.exited, new Promise((done) => setTimeout(done, 5000))]);
      if (!this.stopped) throw new Error(`DSH process ${this.pid} did not exit`);
      await rm(this.stateDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    })();
    return this.stopPromise;
  }
}

/** Each SDK session owns an isolated DSH process, home and provider registration. */
export class DshAgentRuntime {
  private readonly sessions = new Map<string, Session>();
  private closing = false;

  constructor(private readonly vault: VaultService, private readonly dataDir: string,
    private readonly computers?: ComputerRegistry, private readonly skills?: SkillsBridge,
    private readonly memory?: DshMemoryBridge,
    private readonly modelHub?: () => ModelResolver | undefined) {}

  async create(input: { workspaceId: string; cwd: string; computerId?: string; role?: ModelRole; profile?: string }): Promise<{ sessionId: string; pid: number }> {
    if (this.closing) throw new Error('DSH runtime is stopped');
    if (!isAbsolute(input.cwd)) throw new Error('DSH workspace cwd must be absolute');
    const scope = { kind: 'engine' as const, workspaceId: input.workspaceId, subjectId: 'engine-dsh' };
    const secrets = new Map<string, string>();
    for (const name of credentialKeys) {
      const secret = await this.vault.get(scope, name);
      if (secret !== undefined) secrets.set(name, secret);
    }
    let model: string | undefined;
    const hub = this.modelHub?.();
    if (hub?.active) {
      try {
        const resolved = await hub.resolve(input.role ?? 'coding', input.profile);
        model = resolved.model;
        secrets.set('NEO_MODEL_BASE_URL', resolved.baseUrl);
        secrets.set('NEO_MODEL_NAME', resolved.model);
        if (resolved.apiKey) secrets.set('NEO_MODEL_API_KEY', resolved.apiKey);
      } catch (error) {
        if (!(error instanceof Error && error.message.includes('is unconfigured'))) throw error;
      }
    }
    const env = await new DshProjector([...credentialKeys, ...modelKeys]).project(secrets);
    const sessionId = randomUUID();
    if (input.computerId && !this.computers) throw new Error('Computer registry unavailable');
    await mkdir(this.dataDir, { recursive: true });
    const stateDir = join(this.dataDir, randomUUID());
    await mkdir(stateDir);
    const memoryBinding = await this.memory?.binding(sessionId, input.workspaceId);
    try {
      await this.skills?.dshReady(sessionId, join(stateDir, 'home'));
    } catch (error) {
      this.skills?.forgetDsh(sessionId);
      this.memory?.forget(sessionId);
      await rm(stateDir, { recursive: true, force: true });
      throw error;
    }
    const patchSource = await readFile(join(extensionRoot, 'cordis.patch.yml'), 'utf8');
    let patch = patchSource;
    if (!memoryBinding) {
      patch = patch.replace(/    - id: neo-memory-context\r?\n      name: '\.\/neo-memory-plugin\.mjs'\r?\n/, '');
    }
    for (const name of ['@deepseek-ai/dsh-computer-use', '@deepseek-ai/dsh-browser-use']) {
      patch = patch.replace(`name: '${name}'`, `name: '${import.meta.resolve(name)}'`);
    }
    const localPlugins = ['neo-providers.mjs', 'neo-computer-tool.mjs', ...(memoryBinding ? ['neo-memory-plugin.mjs'] : [])];
    for (const name of localPlugins) {
      patch = patch.replace(`name: './${name}'`, `name: '${new URL(`../${name}`, import.meta.url).href}'`);
    }
    const patchFile = join(stateDir, 'cordis.patch.yml');
    await writeFile(patchFile, patch);
    const computerBinding = input.computerId
      ? this.computers?.assign('dsh', sessionId, input.computerId)
      : undefined;
    const session = new Session(sessionId, stateDir, resolve(input.cwd), {
      ...env,
      ...(computerBinding ? {
        NEO_COMPUTER_ENDPOINT: computerBinding.endpoint,
        NEO_COMPUTER_TOKEN: computerBinding.token,
      } : {}),
      ...(memoryBinding ? {
        NEO_MEMORY_ENDPOINT: memoryBinding.endpoint,
        NEO_MEMORY_TOKEN: memoryBinding.token,
        NEO_MEMORY_PROFILE: memoryBinding.profile,
      } : {}),
      DSH_HOME: join(stateDir, 'home'),
      DSH_AGENTS_HOME: join(stateDir, 'agents'),
      DSH_TELEMETRY_DISABLED: '1',
      TMUX: '', TMUX_PANE: '',
    }, patchFile, model);
    try {
      await session.initialize();
      if (this.closing) throw new Error('DSH runtime is stopped');
      this.sessions.set(session.id, session);
      return { sessionId: session.id, pid: session.pid };
    } catch (error) {
      await session.stop(true);
      this.computers?.unassign('dsh', sessionId);
      this.skills?.forgetDsh(sessionId);
      this.memory?.forget(sessionId);
      throw error;
    }
  }

  private session(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown DSH session ${id}`);
    return session;
  }

  prompt(input: { sessionId: string; text: string }) { return this.session(input.sessionId).prompt(input.text); }
  events(input: { sessionId: string; signal?: AbortSignal }) { return this.session(input.sessionId).subscribe(input.signal); }
  wait(input: { sessionId: string }) { return this.session(input.sessionId).wait(); }

  async cancel(input: { sessionId: string }): Promise<{ cancelled: boolean }> {
    const session = this.session(input.sessionId);
    await session.stop(true);
    this.sessions.delete(input.sessionId);
    this.computers?.unassign('dsh', input.sessionId);
    this.skills?.forgetDsh(input.sessionId);
    this.memory?.forget(input.sessionId);
    return { cancelled: true };
  }

  async shutdown(input: { sessionId: string }): Promise<{ stopped: boolean }> {
    const session = this.session(input.sessionId);
    await session.stop();
    this.sessions.delete(input.sessionId);
    this.computers?.unassign('dsh', input.sessionId);
    this.skills?.forgetDsh(input.sessionId);
    this.memory?.forget(input.sessionId);
    return { stopped: true };
  }

  async stop(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.sessions.values()].map((session) => session.stop(true)));
    for (const id of this.sessions.keys()) this.computers?.unassign('dsh', id);
    for (const id of this.sessions.keys()) {
      this.skills?.forgetDsh(id);
      this.memory?.forget(id);
    }
    this.sessions.clear();
  }
}
