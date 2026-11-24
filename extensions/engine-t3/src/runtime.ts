/** Owns one loopback T3 CLI process and its short-lived scoped orchestration session. */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { delimiter, isAbsolute, join, relative, sep } from 'node:path';
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

type RuntimeMarker = {
  pid?: number; gatewayPid?: number; gatewayExecutable?: string; port?: number; origin?: string; startedAt?: string;
};

async function readState(path: string): Promise<RuntimeMarker> {
  try { return JSON.parse(await readFile(path, 'utf8')) ?? {}; }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/** The executable and command line of a live process, or undefined once it has exited. */
async function inspectProcess(pid: number): Promise<{ image: string; command: string } | undefined> {
  if (windows) {
    const { stdout } = await execute(system32('WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { $p.ExecutablePath; $p.CommandLine }`,
    ], { windowsHide: true, timeout: 5000 });
    const [image = '', ...command] = stdout.trim().split(/\r?\n/);
    return image || command.length ? { image, command: command.join('\n') } : undefined;
  }
  const { stdout } = await execute('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], { timeout: 5000 })
    .catch((error: unknown) => { if (isAlive(pid)) throw error; return { stdout: '' }; });
  const command = stdout.trim();
  return command ? { image: command.split(' ')[0], command } : undefined;
}

/** A marker's Gateway PID counts only while it still is a Neo Gateway: Windows reuses PIDs. */
async function isNeoGateway(pid: number, executable?: string): Promise<boolean> {
  const inspected = await inspectProcess(pid).catch(() => undefined);
  if (!inspected) return false;
  // The desktop shell and the dev server both start `<node> --import tsx src/main.ts` (src-tauri/src/lib.rs).
  const gateway = /(^|[\s"])--import\s+tsx\s+"?src[\\/]main\.ts"?(\s|$)/.test(inspected.command);
  if (!gateway || !executable) return gateway;
  return windows ? inspected.image.toLowerCase() === executable.toLowerCase() || inspected.command.toLowerCase().includes(executable.toLowerCase())
    : inspected.image === executable || inspected.command.startsWith(executable + ' ');
}

export class T3OwnedElsewhere extends Error {
  constructor() {
    super('Another Neo Gateway on this computer runs the local T3 server. Close it, then choose Start.');
  }
}

/** A server belongs to the Gateway process, not to one generation, so a staged upgrade reuses it. */
type SharedServer = {
  child: ChildProcess; port: number; launchedAt: number; exited: boolean;
  owners: Set<() => void>; entry?: Promise<SharedServer>;
};
// Generations load separate copies of this module; the registry is per process.
const registryKey = Symbol.for('neometaharness.engine-t3.local-servers');
const registry = globalThis as unknown as Record<symbol, { servers: Map<string, Promise<SharedServer>>; pids: Set<number> } | undefined>;
const { servers, pids: livePids } = registry[registryKey] ??= { servers: new Map(), pids: new Set() };

async function removeStaleServer(marker: string, statePath: string, executable: string, base: string) {
  const owned = await readState(marker);
  if (owned.gatewayPid !== undefined && owned.gatewayPid !== process.pid && isAlive(owned.gatewayPid)
    && await isNeoGateway(owned.gatewayPid, owned.gatewayExecutable)) {
    throw new T3OwnedElsewhere();
  }
  const previous = await readState(statePath);
  const pid = owned.pid ?? previous.pid;
  // Never stop a server that a live generation in this Gateway is serving.
  if (pid === undefined || livePids.has(pid) || !isAlive(pid)) return;
  // A reused PID could belong to an unrelated process. Verify the executable and the isolated state path.
  const inspected = await inspectProcess(pid);
  if (!inspected) return;
  const { image } = inspected;
  const command = windows ? inspected.command.toLowerCase() : inspected.command;
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
  const homes = {
    HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'), TMPDIR: join(root, 'tmp'),
    XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'),
    T3CODE_HOME: join(root, 'state'),
    CODEX_HOME: join(root, 'codex'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'claude', 'plugins'),
    GEMINI_HOME: join(root, 'gemini'),
    ANTIGRAVITY_DATA_DIR: join(root, 'antigravity'),
    GROK_HOME: join(root, 'grok'),
    OPENCODE_DATA_DIR: join(root, 'data', 'opencode'),
  };
  await Promise.all([...new Set(Object.values(homes))].map((home) => mkdir(home, { recursive: true })));
  // Codex maintenance can derive its home from the executable's standalone install.
  // Do not discover private installations through the Gateway's inherited PATH.
  const hostHomes = [original.HOME, original.USERPROFILE].filter((home): home is string => !!home);
  const privateHomes = [
    ...hostHomes.flatMap((home) => ['.t3', '.codex', '.claude'].map((name) => join(home, name))),
    original.T3CODE_HOME, original.CODEX_HOME, original.CLAUDE_CONFIG_DIR, original.GEMINI_HOME, original.GROK_HOME,
  ].filter((home): home is string => !!home && isAbsolute(home));
  const path = (original.PATH ?? original.Path)?.split(delimiter).map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => isAbsolute(entry) && !privateHomes.some((home) => {
      const inside = relative(home, entry);
      return inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside);
    })).join(delimiter);
  const environment: NodeJS.ProcessEnv = {
    PATH: path, PATHEXT: original.PATHEXT,
    SystemRoot: original.SystemRoot, WINDIR: original.WINDIR, ComSpec: original.ComSpec,
    SYSTEMDRIVE: original.SYSTEMDRIVE,
    ...homes,
  };
  // Allow TLS configuration for upstream provider requests, without inheriting the owner's T3 session or tokens.
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) {
    if (original[key]) environment[key] = original[key];
  }
  return environment;
}

type TestOptions = { executable?: string; prefix?: string[]; sessionTtlMs?: number };
const exitedReason = 'The local T3 server exited. Choose Start to try again.';

export class T3LocalRuntime {
  private server?: SharedServer;
  private starting?: Promise<void>;
  private renewal?: NodeJS.Timeout;
  private sessionId?: string;
  private exited = false;
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

  /** True while this Gateway already runs the server, e.g. for the serving generation during an upgrade. */
  static serving(enginesDir: string): boolean { return servers.has(join(enginesDir, 't3-home')); }

  get pid(): number | undefined { return this.server?.child.pid; }
  get pending(): boolean { return !!this.starting; }
  /** The connect or launch in flight, if any. */
  get connecting(): Promise<void> | undefined { return this.starting; }

  start(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.reject(new Error('T3 extension is disabled'));
    if (this.client.connected) return Promise.resolve();
    return this.connect();
  }

  private scheduleRenewal(ms: number) {
    clearTimeout(this.renewal);
    if (this.abort.signal.aborted || !this.server) return;
    this.renewal = setTimeout(() => { void this.connect().catch(() => {}); }, ms).unref();
  }

  private connect(): Promise<void> {
    if (!this.starting) {
      this.reason = this.server ? 'Reconnecting to the local T3 server...' : 'Starting the local T3 server...';
      this.starting = this.connectChild().then(() => {
        this.reason = '';
        this.scheduleRenewal(this.ttlMs * 0.65);
      }).catch((error: unknown) => {
        if (!this.abort.signal.aborted) {
          // Keep a live server and its turns intact even when renewing the connection fails.
          console.error('T3 local connection failed', error instanceof Error ? error.message : error);
          this.reason = error instanceof T3OwnedElsewhere ? error.message
            : this.exited && !this.server ? exitedReason
              : "Couldn't connect to the local T3 server. Choose Start to try again.";
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
    if (!this.server) {
      this.exited = false;
      this.server = await this.acquire(command, prefix, base, env);
    }
    const server = this.server;
    // Wait for the child to publish its own listening address before opening auth storage.
    const origin = await this.waitForChild(server, base);
    const session = ([action, ...args]: string[]) => execute(command, [...prefix, 'auth', 'session', action, '--base-dir', base, ...args],
      { cwd: this.root, env, windowsHide: true, timeout: 30_000, signal: this.abort.signal, maxBuffer: 16_384 });
    // coding-workflow's read-only terminal needs the terminal scopes (T3 v0.1.9 auth/RpcAuthorization.ts:185-191).
    const { stdout } = await session(['issue', '--scope', 'orchestration:read', '--scope', 'orchestration:operate',
      '--scope', 'providers:manage', '--scope', 'terminal:read', '--scope', 'terminal:operate',
      '--ttl', String(this.ttlMs) + 'ms', '--label', 'neo-gateway', '--json']);
    let issued: { sessionId?: unknown; token?: unknown } = {};
    try { issued = JSON.parse(stdout); } catch { /* reported below */ }
    const token = typeof issued.token === 'string' ? issued.token : '';
    if (token.length < 12 || typeof issued.sessionId !== 'string') throw new Error('T3 did not issue a scoped session');
    if (server !== this.server) throw new Error('T3 server exited during session issuance');
    await this.client.connect(origin, token, this.abort.signal, () => this.scheduleRenewal(0));
    // T3 v0.1.9 apps/server/src/cli/auth.ts:217-237: the replaced session stops working right away.
    const previous = this.sessionId;
    this.sessionId = issued.sessionId;
    if (previous) {
      await session(['revoke', previous]).catch((error: unknown) =>
        console.error('T3 could not revoke the previous session', error instanceof Error ? error.message : error));
    }
  }

  /** Reuse the server this Gateway runs for the engines folder, or launch one. */
  private async acquire(command: string, prefix: string[], base: string, env: NodeJS.ProcessEnv): Promise<SharedServer> {
    for (;;) {
      const existing = servers.get(this.root);
      if (existing) {
        const server = await existing.catch(() => undefined);
        if (server && !server.exited) {
          server.owners.add(this.onServerExit);
          return server;
        }
        if (servers.get(this.root) === existing) servers.delete(this.root);
        continue;
      }
      const entry = this.launch(command, prefix, base, env);
      servers.set(this.root, entry);
      entry.catch(() => { if (servers.get(this.root) === entry) servers.delete(this.root); });
      const server = await entry;
      server.entry = entry;
      server.owners.add(this.onServerExit);
      return server;
    }
  }

  private readonly onServerExit = () => {
    clearTimeout(this.renewal);
    this.server = undefined;
    this.sessionId = undefined;
    this.exited = true;
    if (!this.abort.signal.aborted) {
      this.reason = exitedReason;
      void this.client.disconnect(false).catch(() => {});
    }
  };

  private async launch(command: string, prefix: string[], base: string, env: NodeJS.ProcessEnv): Promise<SharedServer> {
    const statePath = join(base, 'userdata', 'server-runtime.json');
    await removeStaleServer(this.marker, statePath, command, base);
    // v0.1.9 rejects port 0 in both its CLI and bootstrap. Trust only the address
    // published by the child for this launch, even if another process takes the candidate port.
    const port = await loopbackPort();
    this.abort.signal.throwIfAborted();
    const child = spawn(command, [...prefix, 'serve', '--mode', 'desktop', '--host', '127.0.0.1',
      '--base-dir', base, '--port', String(port), '--no-browser', '--bootstrap-fd', '0'], {
      cwd: this.root, env, detached: !windows,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const server: SharedServer = { child, port, launchedAt: Date.now(), exited: false, owners: new Set() };
    if (child.pid) livePids.add(child.pid);
    child.stdout?.resume();
    child.stderr?.resume();
    child.stdin?.on('error', () => { /* startup reports the child exit */ });
    child.stdin?.end(JSON.stringify({
      mode: 'desktop', host: '127.0.0.1', noBrowser: true, port, shellEnvironmentPrepared: true,
      desktopBootstrapToken: randomBytes(32).toString('hex'), tailscaleServeEnabled: false, tailscaleServePort: 443,
    }) + '\n');
    const root = this.root;
    const onExit = () => {
      if (server.exited) return;
      server.exited = true;
      if (child.pid) livePids.delete(child.pid);
      if (!windows && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* process group already exited */ }
      }
      if (server.entry && servers.get(root) === server.entry) servers.delete(root);
      const owners = [...server.owners];
      server.owners.clear();
      for (const owner of owners) owner();
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
      try {
        await writeFile(this.marker, JSON.stringify({ pid: child.pid, gatewayPid: process.pid,
          gatewayExecutable: process.execPath }), { mode: 0o600 });
      } catch (error) {
        await stopTree(child.pid).catch(() => {});
        throw error;
      }
    }
    return server;
  }

  private async waitForChild(server: SharedServer, base: string): Promise<string> {
    const statePath = join(base, 'userdata', 'server-runtime.json');
    const deadline = Date.now() + 30_000;
    const origin = `http://127.0.0.1:${server.port}`;
    while (Date.now() < deadline && server === this.server && !server.exited) {
      const state = await readState(statePath);
      if (server.child.pid && state.pid === server.child.pid && state.port === server.port && state.origin === origin
        && Date.parse(state.startedAt ?? '') >= server.launchedAt) {
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
    if (server !== this.server || server.exited) throw new Error('T3 server exited');
    throw new Error('T3 did not publish the address of its loopback server');
  }

  async stop(): Promise<void> {
    this.abort.abort();
    clearTimeout(this.renewal);
    await this.starting?.catch(() => {});
    const server = this.server;
    this.server = undefined;
    try { await this.client.disconnect(); } finally {
      if (server) {
        server.owners.delete(this.onServerExit);
        const pid = server.child.pid;
        if (server.owners.size > 0 && !server.exited) {
          // A newer generation serves from this server now. End only this generation's session.
          if (this.sessionId) await this.revokeOwnSession().catch(() => {});
        } else {
          if (server.entry && servers.get(this.root) === server.entry) servers.delete(this.root);
          if (pid && isAlive(pid)) await stopTree(pid);
          const owner = await readState(this.marker);
          if (owner.pid === pid && owner.gatewayPid === process.pid) await rm(this.marker, { force: true });
        }
      }
    }
  }

  private async revokeOwnSession() {
    const env = await isolatedT3Environment(this.root);
    await execute(this.testOptions?.executable ?? this.executable, [...this.testOptions?.prefix ?? [],
      'auth', 'session', 'revoke', '--base-dir', env.T3CODE_HOME!, this.sessionId!],
    { cwd: this.root, env, windowsHide: true, timeout: 15_000, maxBuffer: 16_384 });
  }
}
