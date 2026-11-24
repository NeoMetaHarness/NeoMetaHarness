/** Owns one loopback T3 CLI process and its short-lived scoped orchestration session. */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { system32 } from './system-tools.js';
import type { T3ControlPlane } from './client.js';

const execute = promisify(execFile);
const windows = process.platform === 'win32';
const taskkill = (pid: number) => ['/PID', String(pid), '/T', '/F'];

async function loopbackPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((done, reject) => listener.once('error', reject).listen(0, '127.0.0.1', done));
  const address = listener.address();
  await new Promise<void>((done) => listener.close(() => done()));
  if (!address || typeof address === 'string') throw new Error('Could not allocate a T3 loopback port');
  return address.port;
}

function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function signalTree(pid: number, signal: NodeJS.Signals) {
  try { process.kill(-pid, signal); } catch {
    try { process.kill(pid, signal); } catch { /* already exited */ }
  }
}

async function stopTree(pid: number) {
  if (windows) {
    await execute(system32('taskkill.exe'), taskkill(pid), { windowsHide: true, timeout: 5000 })
      .catch((error: unknown) => { if (isAlive(pid)) throw error; });
  } else {
    signalTree(pid, 'SIGTERM');
    for (let attempt = 0; isAlive(pid) && attempt < 20; attempt++) await delay(100);
    signalTree(pid, 'SIGKILL');
  }
}

async function readState(path: string): Promise<{ pid?: number; gatewayPid?: number; port?: number; origin?: string; startedAt?: string }> {
  try { return JSON.parse(await readFile(path, 'utf8')) ?? {}; }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

async function removeStaleServer(marker: string, statePath: string, executable: string, base: string) {
  const owned = await readState(marker);
  if (owned.gatewayPid !== undefined && owned.gatewayPid !== process.pid && isAlive(owned.gatewayPid)) {
    throw new Error('Another Gateway owns the local T3 runtime');
  }
  const previous = await readState(statePath);
  const pid = owned.pid ?? previous.pid;
  if (pid === undefined || !isAlive(pid)) return;
  // A reused PID could belong to an unrelated process. Verify the executable and the isolated state path.
  const inspected = windows
    ? await execute(system32('WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { $p.ExecutablePath; $p.CommandLine }`,
    ], { windowsHide: true, timeout: 5000 })
    : await execute('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], { timeout: 5000 })
      .catch((error: unknown) => { if (isAlive(pid)) throw error; return { stdout: '' }; });
  const [image, ...commandLines] = inspected.stdout.trim().split(/\r?\n/);
  const command = windows ? commandLines.join('\n').toLowerCase() : image;
  const normalizedBase = windows ? base.toLowerCase() : base;
  const installed = windows ? image.toLowerCase() === executable.toLowerCase()
    : command.startsWith(executable + ' ') || command.startsWith('"' + executable + '" ');
  if (!installed || !/\sserve\s/.test(command)
    || !(command.endsWith(' --base-dir ' + normalizedBase) || command.endsWith(' --base-dir "' + normalizedBase + '"')
      || command.includes(' --base-dir ' + normalizedBase + ' ') || command.includes(' --base-dir "' + normalizedBase + '" '))) return;
  await stopTree(pid);
  for (let attempt = 0; isAlive(pid) && attempt < 30; attempt++) await delay(100);
  if (isAlive(pid)) throw new Error('The previous Neo T3 server is still running');
}

/** Each service has a Neo-owned home, including all standard user-data and cache locations. */
export async function isolatedT3Environment(root: string, original = process.env): Promise<NodeJS.ProcessEnv> {
  const folders = ['home', 'appdata', 'localappdata', 'tmp', 'state', 'config', 'cache', 'data', 'codex', 'claude'];
  await Promise.all(folders.map((folder) => mkdir(join(root, folder), { recursive: true })));
  const environment: NodeJS.ProcessEnv = {
    PATH: original.PATH ?? original.Path, PATHEXT: original.PATHEXT,
    SystemRoot: original.SystemRoot, WINDIR: original.WINDIR, ComSpec: original.ComSpec,
    SYSTEMDRIVE: original.SYSTEMDRIVE,
    HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
    APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'), TMPDIR: join(root, 'tmp'),
    XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'),
    T3CODE_HOME: join(root, 'state'),
  };
  // Allow TLS configuration for upstream provider requests, without inheriting the owner's T3 session or tokens.
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) {
    if (original[key]) environment[key] = original[key];
  }
  return environment;
}

type TestOptions = { executable?: string; prefix?: string[]; sessionTtlMs?: number };

export class T3LocalRuntime {
  private child?: ChildProcess;
  private port?: number;
  private launchedAt = 0;
  private ownedPid?: number;
  private starting?: Promise<void>;
  private renewal?: NodeJS.Timeout;
  private readonly abort = new AbortController();
  private readonly ttlMs: number;
  private readonly root: string;
  private readonly marker: string;
  reason = 'Starting the local T3 server...';

  constructor(private readonly client: T3ControlPlane, private readonly executable: string,
    enginesDir: string, private readonly testOptions?: TestOptions) {
    this.root = join(enginesDir, 't3-home');
    this.marker = join(this.root, 'neo-runtime.json');
    this.ttlMs = testOptions?.sessionTtlMs ?? 15 * 60_000;
  }

  get pid(): number | undefined { return this.child?.pid; }
  get pending(): boolean { return !!this.starting; }

  start(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.reject(new Error('T3 extension is disabled'));
    if (this.client.connected) return Promise.resolve();
    return this.connect();
  }

  private scheduleRenewal(ms: number) {
    clearTimeout(this.renewal);
    if (this.abort.signal.aborted || !this.child) return;
    this.renewal = setTimeout(() => { void this.connect().catch(() => {}); }, ms).unref();
  }

  private connect(): Promise<void> {
    if (!this.starting) {
      this.reason = this.child ? 'Reconnecting to the local T3 server...' : 'Starting the local T3 server...';
      this.starting = this.connectChild().then(() => {
        this.reason = '';
        this.scheduleRenewal(this.ttlMs * 0.65);
      }).catch((error: unknown) => {
        if (!this.abort.signal.aborted) {
          // Keep a live server and its turns intact even when renewing the connection fails.
          console.error('T3 local connection failed', error instanceof Error ? error.message : error);
          this.reason = "Couldn't connect to the local T3 server. Choose Start to try again.";
          this.scheduleRenewal(Math.min(3000, this.ttlMs / 3));
        }
        throw error;
      }).finally(() => { this.starting = undefined; });
    }
    return this.starting;
  }

  private async connectChild() {
    const env = await isolatedT3Environment(this.root);
    const base = env.T3CODE_HOME!;
    const command = this.testOptions?.executable ?? this.executable;
    const prefix = this.testOptions?.prefix ?? [];
    if (!this.child) await this.launch(command, prefix, base, env);
    const child = this.child;
    if (!child) throw new Error('T3 server exited');
    // Wait for the child to publish its own listening address before opening auth storage.
    const origin = await this.waitForChild(child, base);
    const { stdout } = await execute(command, [...prefix, 'auth', 'session', 'issue', '--base-dir', base,
      '--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--scope', 'providers:manage',
      '--ttl', String(this.ttlMs) + 'ms', '--label', 'neo-gateway', '--token-only'],
    { cwd: this.root, env, windowsHide: true, timeout: 30_000, signal: this.abort.signal, maxBuffer: 16_384 });
    const token = stdout.trim();
    if (token.length < 12) throw new Error('T3 did not issue a scoped session');
    if (child !== this.child) throw new Error('T3 server exited during session issuance');
    await this.client.connect(origin, token, this.abort.signal, () => this.scheduleRenewal(0));
  }

  private async launch(command: string, prefix: string[], base: string, env: NodeJS.ProcessEnv) {
    const statePath = join(base, 'userdata', 'server-runtime.json');
    await removeStaleServer(this.marker, statePath, command, base);
    // v0.1.9 rejects port 0 in both its CLI and bootstrap. Trust only the address
    // published by the child for this launch, even if another process takes the candidate port.
    const port = await loopbackPort();
    this.abort.signal.throwIfAborted();
    this.port = port;
    this.launchedAt = Date.now();
    const child = spawn(command, [...prefix, 'serve', '--mode', 'desktop', '--host', '127.0.0.1',
      '--base-dir', base, '--port', String(port), '--no-browser', '--bootstrap-fd', '0'], {
      cwd: this.root, env, detached: !windows,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout?.resume();
    child.stderr?.resume();
    child.stdin?.on('error', () => { /* startup reports the child exit */ });
    child.stdin?.end(JSON.stringify({
      mode: 'desktop', host: '127.0.0.1', noBrowser: true, port, shellEnvironmentPrepared: true,
      desktopBootstrapToken: randomBytes(32).toString('hex'), tailscaleServeEnabled: false, tailscaleServePort: 443,
    }) + '\n');
    const onExit = () => {
      if (this.child !== child) return;
      if (!windows && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* process group already exited */ }
      }
      this.child = undefined;
      this.port = undefined;
      clearTimeout(this.renewal);
      if (!this.abort.signal.aborted) {
        this.reason = 'The local T3 server exited. Choose Start to try again.';
        void this.client.disconnect(false).catch(() => {});
      }
    };
    const closeOnExit = () => {
      if (!child.pid || !isAlive(child.pid)) return;
      try {
        if (windows) execFileSync(system32('taskkill.exe'), taskkill(child.pid), { windowsHide: true, timeout: 5000, stdio: 'ignore' });
        else signalTree(child.pid, 'SIGKILL');
      } catch { /* no asynchronous cleanup is possible here */ }
    };
    process.once('exit', closeOnExit);
    child.once('close', () => process.removeListener('exit', closeOnExit));
    child.once('exit', onExit);
    child.once('error', onExit);
    if (child.pid) {
      this.ownedPid = child.pid;
      await writeFile(this.marker, JSON.stringify({ pid: child.pid, gatewayPid: process.pid }), { mode: 0o600 });
    }
  }

  private async waitForChild(child: ChildProcess, base: string): Promise<string> {
    const statePath = join(base, 'userdata', 'server-runtime.json');
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && child === this.child) {
      const state = await readState(statePath);
      const origin = `http://127.0.0.1:${this.port}`;
      if (child.pid && state.pid === child.pid && state.port === this.port && state.origin === origin
        && Date.parse(state.startedAt ?? '') >= this.launchedAt) {
        try {
          // The server has initialized the state DB and can serve its auth routes.
          const response = await fetch(origin + '/api/auth/websocket-ticket', {
            method: 'POST', redirect: 'error',
            signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(1000)]),
          });
          await response.body?.cancel();
          if (response.status === 401 || response.status === 403) return origin;
        } catch { /* The child is still starting. */ }
      }
      await delay(100, undefined, { signal: this.abort.signal });
    }
    throw new Error('T3 did not publish the address of its loopback server');
  }

  async stop(): Promise<void> {
    this.abort.abort();
    clearTimeout(this.renewal);
    await this.starting?.catch(() => {});
    const pid = this.child?.pid;
    try { await this.client.disconnect(); } finally {
      if (pid && isAlive(pid)) await stopTree(pid);
      if (this.ownedPid) {
        const owner = await readState(this.marker);
        if (owner.pid === this.ownedPid && owner.gatewayPid === process.pid) await rm(this.marker, { force: true });
      }
    }
  }
}
