import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

export interface ProcessInitialization {
  routes: { path: string }[];
  contributions: { kind: string; id: string; name?: string }[];
}

/** OS/runtime variables a process extension needs to start; nothing secret. */
const RUNTIME_ENV = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'OS', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TERM',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'NODE_ENV',
]);
/** Toolchain prefixes (uv, Python, XDG dirs, locale) that never carry Neo credentials. */
const RUNTIME_PREFIXES = ['UV_', 'PYTHON', 'XDG_', 'LC_'];

/**
 * Process extensions get an allowlisted environment, like the engine projectors:
 * never the gateway's tokens, auth secret or provider keys (SEC-10).
 */
export function extensionEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (RUNTIME_ENV.has(upper) || RUNTIME_PREFIXES.some((prefix) => upper.startsWith(prefix))) env[key] = value;
  }
  return env;
}

export class ExtensionProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private exited = false;
  readonly pid: number;

  constructor(command: string[], directory: string) {
    const [executable, ...args] = command;
    this.child = spawn(executable!, args, {
      cwd: directory,
      env: extensionEnv(),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pid = this.child.pid ?? -1;
    const reader = createInterface({ input: this.child.stdout });
    reader.on('line', (line) => this.receive(line));
    this.child.stderr.resume();
    this.child.once('error', (error) => { this.exited = true; this.failAll(error); });
    this.child.once('exit', () => {
      this.exited = true;
      this.failAll(new Error(`Extension process ${this.pid} exited`));
    });
  }

  private receive(line: string): void {
    try {
      const reply = JSON.parse(line) as { jsonrpc: string; id: number; result?: unknown; error?: { message: string } };
      const pending = this.pending.get(reply.id);
      if (!pending || reply.jsonrpc !== '2.0') return;
      clearTimeout(pending.timer);
      this.pending.delete(reply.id);
      if (reply.error) pending.reject(new Error(reply.error.message));
      else pending.resolve(reply.result);
    } catch {
      this.failAll(new Error('Invalid newline JSON-RPC response'));
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error(`Extension process exited: ${this.pid}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Extension RPC ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (error) => {
        if (error) {
          const pending = this.pending.get(id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(id);
            reject(error);
          }
        }
      });
    });
  }

  async initialize(id: string, storage: { dataDir?: string; projectionDir?: string } = {}): Promise<ProcessInitialization> {
    const result = await this.call('initialize', { id, ...storage });
    if (!result || typeof result !== 'object') throw new Error(`Invalid initialize response from ${id}`);
    const data = result as ProcessInitialization;
    if (!Array.isArray(data.routes) || !Array.isArray(data.contributions)) throw new Error(`Missing registrations from ${id}`);
    return data;
  }

  async health(): Promise<{ ok: boolean; pid?: number }> {
    const value = await this.call('health');
    if (!value || typeof value !== 'object' || (value as { ok?: unknown }).ok !== true) {
      throw new Error('Unhealthy process extension');
    }
    return value as { ok: boolean; pid?: number };
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    // Observe exit before shutdown, since a cooperative extension can exit
    // immediately after acknowledging the request.
    const exited = once(this.child, 'exit').then(() => true, () => true);
    try { await this.call('shutdown', {}, 1500); } catch { /* Kill unresponsive extensions below. */ }
    this.child.stdin.end();
    if (this.exited) return;
    if (await Promise.race([exited, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 750))])) return;
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill.exe', ['/PID', String(this.pid), '/T', '/F'], { windowsHide: true });
        killer.once('error', () => resolve());
        killer.once('exit', () => resolve());
      });
    } else {
      try { process.kill(-this.pid, 'SIGKILL'); } catch { this.child.kill('SIGKILL'); }
    }
    if (!this.exited) await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}
