/** Owns one loopback T3 CLI process and its short-lived scoped orchestration session. */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { T3ControlPlane } from './client.js';

const execute = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function unusedPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((done, reject) => listener.once('error', reject).listen(0, '127.0.0.1', done));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback port for T3');
  await new Promise<void>((done) => listener.close(() => done()));
  return address.port;
}

/** Each service has a Neo-owned home, including all standard user-data and cache locations. */
export async function isolatedT3Environment(root: string, original = process.env): Promise<NodeJS.ProcessEnv> {
  const folders = ['home', 'appdata', 'localappdata', 'tmp', 'state', 'config', 'cache', 'data'];
  await Promise.all(folders.map((folder) => mkdir(join(root, folder), { recursive: true })));
  const environment: NodeJS.ProcessEnv = {
    PATH: original.PATH, Path: original.Path, PATHEXT: original.PATHEXT,
    SystemRoot: original.SystemRoot, WINDIR: original.WINDIR, ComSpec: original.ComSpec,
    SYSTEMDRIVE: original.SYSTEMDRIVE,
    HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'), TMPDIR: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'),
    T3CODE_HOME: join(root, 'state'),
  };
  // Allow TLS configuration for upstream provider requests, without inheriting the owner's T3 session or tokens.
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) {
    if (original[key]) environment[key] = original[key];
  }
  return environment;
}

type Command = { executable: string; prefix?: string[] };
export class T3LocalRuntime {
  private child?: ChildProcess;
  private starting?: Promise<void>;
  private readonly abort = new AbortController();
  private disposed = false;
  private output = '';
  private spawnError?: Error;
  reason = 'Starting the local T3 server…';

  constructor(private readonly client: T3ControlPlane, private readonly executable: string,
    private readonly enginesDir: string, private readonly testCommand?: Command) {}

  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('T3 extension is disabled'));
    if (this.client.connected) return Promise.resolve();
    if (!this.starting) {
      this.reason = 'Starting the local T3 server…';
      this.starting = this.launch().catch((error: unknown) => {
        if (!this.disposed) this.reason = `Couldn't start the local T3 server. ${error instanceof Error ? error.message : String(error)}`;
        throw error;
      }).finally(() => { this.starting = undefined; });
    }
    return this.starting;
  }

  private async launch(): Promise<void> {
    const root = join(this.enginesDir, 't3-home');
    const env = await isolatedT3Environment(root);
    const base = env.T3CODE_HOME!;
    const port = await unusedPort();
    if (this.abort.signal.aborted) return;
    const command = this.testCommand?.executable ?? this.executable;
    const prefix = this.testCommand?.prefix ?? [];
    const child = spawn(command, [...prefix, 'serve', '--mode', 'desktop', '--host', '127.0.0.1', '--port', String(port),
      '--base-dir', base, '--no-browser'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.output = '';
    this.spawnError = undefined;
    // A missing executable emits 'error' instead of 'exit'. Listen before any async work.
    child.on('error', (error) => { this.spawnError = error; });
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (chunk: Buffer) => { this.output = (this.output + chunk.toString('utf8')).slice(-1500); });
    }
    child.once('exit', () => {
      if (this.child !== child) return;
      this.child = undefined;
      if (!this.disposed) {
        this.reason = 'The local T3 server exited. Choose Start to try again.';
        void this.client.disconnect().catch(() => {});
      }
    });
    const closeOnExit = () => { if (child.exitCode === null) child.kill(); };
    process.once('exit', closeOnExit);
    child.once('close', () => process.removeListener('exit', closeOnExit));

    try {
      const { stdout } = await execute(command, [...prefix, 'auth', 'session', 'issue', '--base-dir', base,
        '--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--scope', 'providers:manage',
        '--ttl', '15m', '--label', `neo-${randomBytes(4).toString('hex')}`, '--token-only'],
      { cwd: root, env, windowsHide: true, timeout: 30_000, signal: this.abort.signal, maxBuffer: 16_384 });
      const token = stdout.trim();
      if (token.length < 12) throw new Error('T3 did not issue a scoped session');
      const origin = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let attempt = 0; attempt < 120 && !this.abort.signal.aborted; attempt++) {
        if (this.spawnError) throw this.spawnError;
        if (child.exitCode !== null || child.signalCode !== null) break;
        try {
          const response = await fetch(`${origin}/api/auth/websocket-ticket`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1800),
          });
          if (response.ok) { ready = true; break; }
          if (response.status !== 503 && response.status !== 502) {
            throw new Error(`T3 refused its scoped session (HTTP ${response.status})`);
          }
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('T3 refused')) throw error;
        }
        await sleep(350);
      }
      if (!ready) throw new Error(`T3 server did not become ready. ${this.output.slice(-250)}`);
      if (this.abort.signal.aborted) return;
      await this.client.connect(origin, token);
      if (this.abort.signal.aborted) await this.client.disconnect();
      else this.reason = '';
    } catch (error) {
      await this.terminate(child);
      throw error;
    }
  }

  private async terminate(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32' && child.pid) {
      // T3's server may launch provider helpers. Terminate the full owned process tree.
      await execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 5000 }).catch(() => {});
      if (child.exitCode !== null || child.signalCode !== null) return;
    }
    child.kill();
    await Promise.race([new Promise<void>((done) => child.once('close', () => done())), sleep(3500)]);
    if (child.exitCode === null && child.signalCode === null && child.pid && process.platform === 'win32') {
      await execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }).catch(() => {});
    } else if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }

  async stop(): Promise<void> {
    this.disposed = true;
    this.abort.abort();
    if (this.child) await this.terminate(this.child);
    await this.starting?.catch(() => {});
    await this.client.disconnect();
  }
}
