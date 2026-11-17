import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { HermesEvent } from '@neometaharness/contracts';

const exec = promisify(execFile);
const extensionDir = fileURLToPath(new URL('../', import.meta.url));
const repoDir = resolve(extensionDir, '../..');
const cacheDir = join(extensionDir, '.cache');
const terminalStates = new Set(['completed', 'cancelled', 'interrupted', 'failed']);

function upstreamPath(): string {
  const lock = JSON.parse(readFileSync(join(repoDir, 'upstream.lock.json'), 'utf8')) as {
    pins: Record<string, { ref: string }>;
  };
  let root = process.env.NMH_UPSTREAM_CACHE;
  if (!root) {
    for (let dir = repoDir; ; dir = dirname(dir)) {
      const candidate = join(dir, 'nmh-upstream-cache');
      if (existsSync(candidate)) { root = candidate; break; }
      if (dirname(dir) === dir) throw new Error('Hermes upstream cache missing (set NMH_UPSTREAM_CACHE)');
    }
  }
  const pinned = join(root!, `hermes-agent@${lock.pins['hermes-agent']!.ref}`);
  if (!existsSync(join(pinned, 'gateway/platforms/api_server.py'))) throw new Error(`Pinned Hermes not found: ${pinned}`);
  return pinned;
}

async function pythonPath(upstream: string): Promise<string> {
  const venv = join(cacheDir, 'venv');
  const python = process.platform === 'win32' ? join(venv, 'Scripts/python.exe') : join(venv, 'bin/python');
  const marker = join(venv, '.neo-hermes-upstream');
  const installed = await readFile(marker, 'utf8').catch(() => '');
  if (existsSync(python) && installed.trim() === upstream) return python;

  await mkdir(cacheDir, { recursive: true });
  const uvEnv = { ...process.env, UV_CACHE_DIR: join(cacheDir, 'uv-cache') };
  if (!existsSync(python)) {
    await exec('uv', ['venv', venv, '--python', '3.14'], { env: uvEnv, maxBuffer: 2_000_000 });
  }
  const requirements = join(cacheDir, 'requirements.txt');
  // Hermes places the dashboard in [web] and the run API's aiohttp in [sms].
  // Use Hermes's frozen lock so both surfaces have pinned, reproducible deps.
  await exec('uv', ['export', '--project', upstream, '--frozen', '--no-dev',
    '--no-emit-project', '--extra', 'web', '--extra', 'sms',
    '--format', 'requirements-txt', '--output-file', requirements, '--quiet'],
  { env: uvEnv, maxBuffer: 4_000_000 });
  await exec('uv', ['pip', 'sync', '--python', python, requirements], { env: uvEnv, maxBuffer: 2_000_000 });
  await writeFile(marker, `${upstream}\n`, 'utf8');
  return python;
}

function profileName(name: string): string {
  const value = name.trim().toLowerCase();
  if (value !== 'default' && !/^[a-z][a-z0-9_-]{0,47}$/.test(value)) throw new Error('Invalid Hermes profile name');
  return value;
}

function secret(): string { return randomBytes(32).toString('hex'); }

/** Supplied later by @neometaharness/vault without changing Hermes lifecycle code. */
export interface CredentialSource {
  get(profile: string): Promise<string | undefined>;
  set(profile: string, key: string): Promise<void>;
  delete(profile: string): Promise<void>;
}

export class ProfileFileCredentials implements CredentialSource {
  constructor(private readonly home: string) {}
  private file(name: string): string {
    const profile = profileName(name);
    return join(profile === 'default' ? this.home : join(this.home, 'profiles', profile), '.env');
  }
  async get(profile: string): Promise<string | undefined> {
    const content = await readFile(this.file(profile), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    return /^API_SERVER_KEY=([a-f0-9]{64})\s*$/m.exec(content)?.[1];
  }
  async set(profile: string, key: string): Promise<void> {
    const path = this.file(profile);
    await mkdir(dirname(path), { recursive: true });
    const old = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const withoutKey = old.split(/\r?\n/).filter((line) => !/^API_SERVER_KEY=/.test(line)).join('\n').trimEnd();
    await writeFile(path, `${withoutKey}\nAPI_SERVER_KEY=${key}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  async delete(_profile: string): Promise<void> {
    // Hermes removes its own profile directory and the contained .env file.
  }
}

interface HostedProcess { child: ChildProcess; port: number; surface: 'dashboard' | 'api'; }

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Invalid loopback listener');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

async function killTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']).catch(() => {});
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
  }
  await Promise.race([
    new Promise<void>((done) => child.once('close', () => done())),
    new Promise<void>((done) => setTimeout(done, 5000)),
  ]);
  if (child.exitCode === null) {
    try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already stopped */ }
  }
}

export class HermesRuntime {
  private readonly home = resolve(process.env.NMH_HERMES_HOME ?? join(cacheDir, 'home'));
  private readonly credentials: CredentialSource;
  private readonly dashboardToken = secret();
  private dashboard?: HostedProcess;
  private readonly api = new Map<string, HostedProcess>();
  private readonly starting = new Map<string, Promise<HostedProcess>>();
  private readonly closingProfiles = new Set<string>();
  private readonly streams = new Set<AbortController>();
  private python = '';
  private upstream = '';
  private stopped = false;

  constructor(credentials: CredentialSource = new ProfileFileCredentials(resolve(process.env.NMH_HERMES_HOME ?? join(cacheDir, 'home')))) {
    this.credentials = credentials;
  }

  get connected(): boolean { return Boolean(this.dashboard && this.dashboard.child.exitCode === null && !this.stopped); }
  get pid(): number | undefined { return this.dashboard?.child.pid; }

  private profileHome(name: string): string {
    const profile = profileName(name);
    return profile === 'default' ? this.home : join(this.home, 'profiles', profile);
  }

  private async ensureCredential(profile: string): Promise<string> {
    const current = await this.credentials.get(profile);
    if (current) return current;
    const key = secret();
    await this.credentials.set(profile, key);
    return key;
  }

  private async ensureModelConfig(home: string): Promise<void> {
    const modelUrl = process.env.NMH_HERMES_MODEL_URL;
    if (!modelUrl) return;
    const file = join(home, 'config.yaml');
    if (existsSync(file)) return;
    await mkdir(home, { recursive: true });
    await writeFile(file, `model:\n  provider: custom\n  default: fake-model\nproviders:\n  custom:\n    base_url: ${modelUrl}\n    api_key: dummy-key\n`, 'utf8');
  }

  async start(): Promise<void> {
    this.upstream = upstreamPath();
    this.python = await pythonPath(this.upstream);
    await mkdir(this.home, { recursive: true });
    await this.ensureModelConfig(this.home);
    const key = await this.ensureCredential('default');
    try {
      this.dashboard = await this.launch('dashboard', 'default', key);
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  private async launch(surface: 'dashboard' | 'api', profile: string, key: string): Promise<HostedProcess> {
    if (this.stopped) throw new Error('Hermes extension has stopped');
    const port = await freePort();
    const home = this.profileHome(profile);
    const child = spawn(this.python, ['-u', join(extensionDir, 'src/bridge.py'), surface, '--port', String(port)], {
      cwd: this.upstream,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: [surface === 'api' ? 'pipe' : 'ignore', 'ignore', 'pipe'],
      env: {
        ...process.env, HERMES_HOME: home, API_SERVER_KEY: key,
        HERMES_DASHBOARD_SESSION_TOKEN: this.dashboardToken,
        HERMES_DISABLE_LAZY_INSTALLS: '1', HERMES_EXEC_ASK: '1', API_SERVER_ENABLED: 'true',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONPATH: [this.upstream, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
      },
    });
    let errorText = '';
    child.stderr?.on('data', (chunk: Buffer) => { errorText = (errorText + chunk.toString()).slice(-8000); });
    const hosted = { child, port, surface };
    const url = `http://127.0.0.1:${port}${surface === 'dashboard' ? '/api/profiles' : '/health'}`;
    for (let attempt = 0; attempt < 450 && !this.stopped; attempt++) {
      if (child.exitCode !== null) break;
      try {
        const headers: Record<string, string> = surface === 'dashboard' ? { 'X-Hermes-Session-Token': this.dashboardToken } : {};
        if ((await fetch(url, { headers, signal: AbortSignal.timeout(500) })).ok) return hosted;
      } catch { /* still booting */ }
      await new Promise<void>((done) => setTimeout(done, 100));
    }
    await killTree(child);
    throw new Error(`Hermes ${surface} failed to start: ${errorText.slice(-3000)}`);
  }

  private async server(profile: string): Promise<HostedProcess> {
    const name = profileName(profile);
    if (this.closingProfiles.has(name)) throw new Error(`Hermes profile ${name} is closing`);
    const active = this.api.get(name);
    if (active && active.child.exitCode === null) return active;
    let pending = this.starting.get(name);
    if (!pending) {
      pending = (async () => {
        const home = this.profileHome(name);
        if (!existsSync(home)) throw new Error(`Unknown Hermes profile: ${name}`);
        await this.ensureModelConfig(home);
        const key = await this.ensureCredential(name);
        const instance = await this.launch('api', name, key);
        this.api.set(name, instance);
        return instance;
      })().finally(() => this.starting.delete(name));
      this.starting.set(name, pending);
    }
    return pending;
  }

  private async request(surface: 'dashboard' | 'api', path: string, options: {
    method?: string; body?: object; profile?: string; signal?: AbortSignal;
  } = {}): Promise<Response> {
    if (this.stopped) throw new Error('Hermes extension disabled');
    const hosted = surface === 'dashboard' ? this.dashboard : await this.server(options.profile ?? 'default');
    if (!hosted) throw new Error('Hermes dashboard unavailable');
    const key = surface === 'dashboard' ? this.dashboardToken : await this.ensureCredential(options.profile ?? 'default');
    const headers: Record<string, string> = surface === 'dashboard' ? { 'X-Hermes-Session-Token': key } : { Authorization: `Bearer ${key}` };
    const response = await fetch(`http://127.0.0.1:${hosted.port}${path}`, {
      method: options.method ?? 'GET', headers: { ...headers, 'content-type': 'application/json' },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}), signal: options.signal ?? AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Hermes ${surface} ${path} returned ${response.status}: ${(await response.text()).slice(0, 400)}`);
    return response;
  }

  async listProfiles(): Promise<{ profiles: { name: string; path: string }[] }> {
    return this.request('dashboard', '/api/profiles').then(async (r) => await r.json() as { profiles: { name: string; path: string }[] });
  }
  async createProfile(name: string): Promise<{ ok: boolean; name: string; path: string }> {
    const canonical = profileName(name);
    if (canonical === 'default') throw new Error('Default profile already exists');
    const response = await this.request('dashboard', '/api/profiles', { method: 'POST', body: { name: canonical } });
    const created = await response.json() as { ok: boolean; name: string; path: string };
    await this.ensureCredential(canonical);
    await this.ensureModelConfig(this.profileHome(canonical));
    return created;
  }
  async deleteProfile(name: string): Promise<{ ok: boolean }> {
    const canonical = profileName(name);
    if (canonical === 'default') throw new Error('Cannot delete default profile');
    if (this.closingProfiles.has(canonical)) throw new Error(`Hermes profile ${canonical} is closing`);
    this.closingProfiles.add(canonical);
    try {
      await this.stopProfile(canonical);
      const response = await this.request('dashboard', `/api/profiles/${encodeURIComponent(canonical)}`, { method: 'DELETE' });
      await this.credentials.delete(canonical);
      return await response.json() as { ok: boolean };
    } finally {
      this.closingProfiles.delete(canonical);
    }
  }
  async listCron(): Promise<Record<string, unknown>[]> { return this.request('dashboard', '/api/cron/jobs').then(async (r) => await r.json() as Record<string, unknown>[]); }
  async createCron(prompt: string, schedule: string): Promise<{ id: string }> {
    return this.request('dashboard', '/api/cron/jobs', { method: 'POST', body: { prompt, schedule } }).then(async (r) => await r.json() as { id: string });
  }
  async deleteCron(id: string): Promise<{ ok: boolean }> {
    return this.request('dashboard', `/api/cron/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(async (r) => await r.json() as { ok: boolean });
  }
  async startRun(profile: string, input: string): Promise<{ run_id: string }> {
    return this.request('api', '/v1/runs', { method: 'POST', profile, body: { input } }).then(async (r) => await r.json() as { run_id: string });
  }
  async approve(profile: string, runId: string, choice: 'once' | 'session' | 'deny'): Promise<{ ok: boolean }> {
    await this.request('api', `/v1/runs/${encodeURIComponent(runId)}/approval`, { method: 'POST', profile, body: { choice } });
    return { ok: true };
  }
  async stopRun(profile: string, runId: string): Promise<{ status: string }> {
    const path = `/v1/runs/${encodeURIComponent(runId)}`;
    await this.request('api', `${path}/stop`, { method: 'POST', profile, body: {} });
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await this.request('api', path, { profile }).then((r) => r.json()) as { status: string };
      if (terminalStates.has(status.status)) return { status: status.status };
      await new Promise<void>((done) => setTimeout(done, 100));
    }
    throw new Error(`Hermes run ${runId} did not settle after stop`);
  }

  async *events(profile: string, runId: string, signal?: AbortSignal): AsyncGenerator<HermesEvent> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    this.streams.add(controller);
    try {
      const response = await this.request('api', `/v1/runs/${encodeURIComponent(runId)}/events`, {
        profile, signal: controller.signal,
      });
      if (!response.body) throw new Error('Hermes SSE stream has no body');
      const decoder = new TextDecoder();
      let buffer = '';
      let sequence = 0;
      for await (const bytes of response.body) {
        buffer += decoder.decode(bytes, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const payload = JSON.parse(data) as Record<string, unknown>;
          const type = String(payload.event ?? 'unknown');
          const delta = type === 'message.delta' ? (payload.delta ?? payload.text ?? payload.content) : undefined;
          const event: HermesEvent = typeof delta === 'string'
            ? { kind: 'text.delta', sequence: ++sequence, type, messageId: runId, textDelta: delta, payload }
            : { kind: 'event', sequence: ++sequence, type, payload };
          yield event;
          if (type === 'run.completed' || type === 'run.failed' || type === 'run.cancelled' || type === 'run.interrupted') return;
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      controller.abort();
      this.streams.delete(controller);
      signal?.removeEventListener('abort', abort);
    }
  }

  private async stopProfile(profile: string): Promise<void> {
    const children = new Set<ChildProcess>();
    const running = this.api.get(profile);
    if (running) children.add(running.child);
    // Another request can be launching a replacement for a bridge that exited.
    // Wait for it before removing the profile so it cannot reopen SQLite files.
    const pending = this.starting.get(profile);
    if (pending) {
      try { children.add((await pending).child); } catch { /* launch already cleans up failed children */ }
    }
    const current = this.api.get(profile);
    if (current) children.add(current.child);
    this.api.delete(profile);
    await Promise.all([...children].map(async (child) => {
      if (child.exitCode !== null) return;
      // Ask Hermes to close its SQLite stores before removing the profile.
      child.stdin?.end();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          new Promise<void>((done) => child.once('close', () => done())),
          new Promise<void>((done) => { timer = setTimeout(done, 4000); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (child.exitCode === null) await killTree(child);
    }));
  }
  async disconnect(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const stream of this.streams) stream.abort();
    await Promise.allSettled([...this.starting.values()]);
    await Promise.all([...this.api.keys()].map((profile) => this.stopProfile(profile)));
    if (this.dashboard) { await killTree(this.dashboard.child); this.dashboard = undefined; }
  }
}
