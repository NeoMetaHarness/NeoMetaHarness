import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { HermesEvent } from '@neometaharness/contracts';
import { engineFolder, resolveEngineSource, upstreamLockFile, type EngineSource, type EngineSourceOrigin } from '@neometaharness/kernel';
import { DshProjector, type VaultService, type VaultScope } from '@neometaharness/vault';
import { HermesSubscription } from './subscription.js';

const exec = promisify(execFile);
const extensionDir = fileURLToPath(new URL('../', import.meta.url));
const repoDir = resolve(extensionDir, '../..');
const cacheDir = join(extensionDir, '.cache');
const terminalStates = new Set(['completed', 'cancelled', 'interrupted', 'failed']);

/** Share the vault's OS-only projection between installer and Hermes processes. */
export async function hermesBaseEnvironment(): Promise<Record<string, string>> {
  return new DshProjector([]).project(new Map());
}

/** The pinned Hermes checkout (P7-16): the development cache, else the app-data engines folder. */
export const HERMES_PIN = 'hermes-agent';
const HERMES_PROBE = 'gateway/platforms/api_server.py';

/** upstream.lock.json of the Gateway's runtime root, else of this source tree (see upstreamLockFile). */
export function hermesLockFile(runtimeRoot?: string): string {
  return upstreamLockFile(runtimeRoot, repoDir);
}

/** Where a Hermes venv, uv's cache and uv-managed Python live for one source. */
export interface HermesLayout { venv: string; uvCache: string; pythonInstallDir?: string; requirements: string }
export interface HermesSource { path: string; origin: EngineSourceOrigin; layout: HermesLayout }

export function hermesLayout(source: Pick<EngineSource, 'origin' | 'pin'>, enginesDir?: string): HermesLayout {
  if (source.origin === 'dev-cache' || !enginesDir) {
    // Development: unchanged, next to the extension.
    return { venv: join(cacheDir, 'venv'), uvCache: join(cacheDir, 'uv-cache'), requirements: join(cacheDir, 'requirements.txt') };
  }
  // Installed apps: the unpacked runtime is versioned and replaced on update, so everything Hermes needs to run
  // lives in the app data folder. An explicit UV_CACHE_DIR / UV_PYTHON_INSTALL_DIR still wins (tests share caches).
  const folder = engineFolder(source.pin);
  return {
    venv: join(enginesDir, 'venvs', folder),
    uvCache: process.env.UV_CACHE_DIR ?? join(enginesDir, 'uv-cache'),
    pythonInstallDir: process.env.UV_PYTHON_INSTALL_DIR ?? join(enginesDir, 'python'),
    requirements: join(enginesDir, 'venvs', `${folder}.requirements.txt`),
  };
}

export function hermesSourceOptions(enginesDir?: string, runtimeRoot?: string) {
  return { name: HERMES_PIN, lockFile: hermesLockFile(runtimeRoot), searchFrom: repoDir, probe: HERMES_PROBE, ...(enginesDir ? { enginesDir } : {}) };
}

export function resolveHermesSource(enginesDir?: string, runtimeRoot?: string): HermesSource | undefined {
  const source = resolveEngineSource(hermesSourceOptions(enginesDir, runtimeRoot));
  return source && { path: source.path, origin: source.origin, layout: hermesLayout(source, enginesDir) };
}

/**
 * uv, in order: NMH_UV, the uv the installer bundles next to the Gateway sidecar (the sidecar is the Node
 * executable running this process), then PATH.
 */
export function uvExecutable(): string {
  const name = process.platform === 'win32' ? 'uv.exe' : 'uv';
  const configured = process.env.NMH_UV;
  if (configured && existsSync(configured)) return configured;
  const bundled = join(dirname(process.execPath), name);
  if (existsSync(bundled)) return bundled;
  return 'uv';
}

const DEPENDENCY_SET = 'web,sms,telegram,mcp';
function pythonExecutable(layout: HermesLayout): string {
  return process.platform === 'win32' ? join(layout.venv, 'Scripts/python.exe') : join(layout.venv, 'bin/python');
}

/**
 * True when the venv for this exact source and dependency set is ready (no uv run needed). The venv python is
 * actually run: a venv whose base interpreter was removed (uninstalled system Python, cleared uv cache) is broken
 * even though its files and marker remain.
 */
export async function hermesVenvReady(upstream: string, layout: HermesLayout): Promise<boolean> {
  const installed = await readFile(join(layout.venv, '.neo-hermes-upstream'), 'utf8').catch(() => '');
  const python = pythonExecutable(layout);
  if (!existsSync(python) || installed.trim() !== `${upstream}|${DEPENDENCY_SET}`) return false;
  return pythonRuns(python);
}

/** The interpreter starts. execFile throws synchronously for some bad executables on Windows (spawn UNKNOWN). */
async function pythonRuns(python: string): Promise<boolean> {
  try { await exec(python, ['-c', ''], { timeout: 30_000, windowsHide: true }); return true; } catch { return false; }
}

/** Proxy and CA settings uv needs behind a corporate proxy; the vault projection carries OS variables only. */
const UV_PASSTHROUGH = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'UV_NATIVE_TLS'];
export function uvPassthrough(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(UV_PASSTHROUGH.flatMap((key) => (env[key] ? [[key, env[key]!]] : [])));
}

/** Create or sync the Hermes venv with uv. `step` names each uv step for progress reporting. */
export async function hermesPython(upstream: string, layout: HermesLayout, options: {
  signal?: AbortSignal; step?: (step: 'python' | 'dependencies') => void;
} = {}): Promise<string> {
  const python = pythonExecutable(layout);
  const marker = join(layout.venv, '.neo-hermes-upstream');
  const dependencySet = `${upstream}|${DEPENDENCY_SET}`;
  if (await hermesVenvReady(upstream, layout)) return python;

  await mkdir(dirname(layout.venv), { recursive: true });
  await mkdir(dirname(layout.requirements), { recursive: true });
  const uv = uvExecutable();
  // Installed apps use only uv-managed Python under the engines folder, so the venv never depends on a system
  // Python the user may later remove or upgrade.
  const uvEnv: Record<string, string> = { ...await hermesBaseEnvironment(), ...uvPassthrough(), UV_CACHE_DIR: layout.uvCache,
    ...(layout.pythonInstallDir ? { UV_PYTHON_INSTALL_DIR: layout.pythonInstallDir, UV_PYTHON_PREFERENCE: 'only-managed' } : {}) };
  const run = (args: string[], maxBuffer: number) => exec(uv, args, { env: uvEnv, maxBuffer, signal: options.signal, windowsHide: true });
  if (existsSync(python) && !await pythonRuns(python)) {
    await rm(layout.venv, { recursive: true, force: true }); // broken venv: rebuild it
  }
  if (!existsSync(python)) {
    options.step?.('python');
    await run(['venv', layout.venv, '--python', '3.14'], 2_000_000);
  }
  options.step?.('dependencies');
  // Hermes places the dashboard in [web] and the run API's aiohttp in [sms].
  // MCP discovery requires the optional SDK (pinned Hermes pyproject.toml:430-434;
  // tools/mcp_tool_discovery.py:639-641 otherwise silently returns no tools).
  // Use Hermes's frozen lock so both surfaces have pinned, reproducible deps.
  await run(['export', '--project', upstream, '--frozen', '--no-dev',
    '--no-emit-project', '--extra', 'web', '--extra', 'sms', '--extra', 'telegram', '--extra', 'mcp',
    '--format', 'requirements-txt', '--output-file', layout.requirements, '--quiet'], 4_000_000);
  await run(['pip', 'sync', '--python', python, layout.requirements], 2_000_000);
  await writeFile(marker, `${dependencySet}\n`, 'utf8');
  return python;
}

function profileName(name: string): string {
  const value = name.trim().toLowerCase();
  if (value !== 'default' && !/^[a-z][a-z0-9_-]{0,47}$/.test(value)) throw new Error('Invalid Hermes profile name');
  return value;
}

function secret(): string { return randomBytes(32).toString('hex'); }

/** Per-profile credentials. The vault implementation migrates existing profile keys. */
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

/** The encrypted vault owns credentials, while Hermes still reads its profile .env. */
export class VaultCredentials implements CredentialSource {
  private readonly files: ProfileFileCredentials;
  constructor(private readonly vault: VaultService, home: string) {
    this.files = new ProfileFileCredentials(home);
  }
  /** Hermes profiles are deployment-level runtime bindings (P1-13), so their credentials use the deployment scope. */
  private scope(profile: string): VaultScope {
    return { kind: 'engine', workspaceId: 'default', subjectId: `engine-hermes/${profileName(profile)}` };
  }
  async get(profile: string): Promise<string | undefined> {
    const scope = this.scope(profile);
    let key = await this.vault.get(scope, 'API_SERVER_KEY');
    if (!key) {
      key = await this.files.get(profile);
      if (key) await this.vault.put(scope, 'API_SERVER_KEY', key);
    }
    if (key && await this.files.get(profile) !== key) await this.files.set(profile, key);
    return key;
  }
  async set(profile: string, key: string): Promise<void> {
    await this.vault.put(this.scope(profile), 'API_SERVER_KEY', key);
    await this.files.set(profile, key);
  }
  async delete(profile: string): Promise<void> {
    await this.vault.delete(this.scope(profile), 'API_SERVER_KEY');
    await this.files.delete(profile);
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
    await exec(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F']).catch(() => {});
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
  readonly subscription = new HermesSubscription((path, method) => this.request('dashboard', path, { method }));
  private readonly home: string;
  private readonly credentials: CredentialSource;
  private readonly dashboardToken = secret();
  private dashboard?: HostedProcess;
  private readonly api = new Map<string, HostedProcess>();
  private readonly starting = new Map<string, Promise<HostedProcess>>();
  private readonly closingProfiles = new Set<string>();
  private readonly streams = new Set<AbortController>();
  private readonly projectionVersions = new Map<string, string | undefined>();
  private readonly curatorPids = new Set<number>();
  private readonly learnProcesses = new Set<ChildProcess>();
  private python = '';
  private upstream = '';
  private stopped = false;

  constructor(
    credentials: CredentialSource = new ProfileFileCredentials(resolve(process.env.NMH_HERMES_HOME ?? join(cacheDir, 'home'))),
    private readonly onProfileReady?: (profile: string, home: string) => Promise<string | undefined>,
    home = resolve(process.env.NMH_HERMES_HOME ?? join(cacheDir, 'home')),
  ) {
    this.home = resolve(home);
    this.credentials = credentials;
  }

  get connected(): boolean { return Boolean(this.dashboard && this.dashboard.child.exitCode === null && !this.stopped); }
  get pid(): number | undefined { return this.dashboard?.child.pid; }
  
  /** Hermes v0.23.2 chat_ws.py:650 and methods_display.py:50,60.
   * Credentials stay inside the extension-to-extension interface. */
  screenConnection(profile: string): { url: string; sessionToken: string } {
    profileName(profile);
    if (!this.connected || !this.dashboard) throw new Error('Hermes dashboard unavailable');
    return { url: `ws://127.0.0.1:${this.dashboard.port}/api/ws`, sessionToken: this.dashboardToken };
  }


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

  /** Start on a resolved source; without one, the development cache (as before P7-16). */
  async start(source: HermesSource | undefined = resolveHermesSource()): Promise<void> {
    if (!source) throw new Error('Hermes is not installed');
    this.upstream = source.path;
    this.python = await hermesPython(this.upstream, source.layout);
    await mkdir(this.home, { recursive: true });
    await this.ensureModelConfig(this.home);
    await this.onProfileReady?.('default', this.home);
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
    const runtimeEnv = await hermesBaseEnvironment();
    const child = spawn(this.python, ['-u', join(extensionDir, 'src/bridge.py'), surface, '--port', String(port)], {
      cwd: this.upstream,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: [surface === 'api' ? 'pipe' : 'ignore', 'ignore', 'pipe'],
      env: {
        ...runtimeEnv, HERMES_HOME: home, API_SERVER_KEY: key,
        ...(surface === 'dashboard' ? { HERMES_DESKTOP: '1' } : {}),
        HERMES_DASHBOARD_SESSION_TOKEN: this.dashboardToken,
        HERMES_DISABLE_LAZY_INSTALLS: '1', HERMES_EXEC_ASK: '1', API_SERVER_ENABLED: 'true',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONPATH: this.upstream,
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
    const home = this.profileHome(name);
    if (!existsSync(home)) throw new Error(`Unknown Hermes profile: ${name}`);
    await this.ensureModelConfig(home);
    const version = await this.onProfileReady?.(name, home);
    if (this.projectionVersions.has(name) && this.projectionVersions.get(name) !== version) {
      await this.stopProfile(name);
    }
    this.projectionVersions.set(name, version);
    const active = this.api.get(name);
    if (active && active.child.exitCode === null) return active;
    let pending = this.starting.get(name);
    if (!pending) {
      pending = (async () => {
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

  /** Channel adapters use the same pinned Hermes install and Neo-owned profile. */
  channelRuntime(profile: string): { home: string; python: string; upstream: string } {
    const home = this.profileHome(profile);
    if (this.stopped || !this.python || !existsSync(home)) throw new Error('Hermes profile unavailable');
    return { home, python: this.python, upstream: this.upstream };
  }

  /** Pinned Hermes dashboard messaging API, with no credential mutation. */
  async channelPlatforms(profile: string): Promise<{ platforms: Record<string, unknown>[] }> {
    const name = profileName(profile);
    const response = await this.request('dashboard', `/api/messaging/platforms?profile=${encodeURIComponent(name)}`);
    return response.json() as Promise<{ platforms: Record<string, unknown>[] }>;
  }

  /** Hermes owns platform configuration, while Neo Vault owns every secret. */
  async channelEnabled(profile: string, platform: string, enabled: boolean): Promise<void> {
    const name = profileName(profile);
    if (!/^[a-z][a-z0-9_-]*$/.test(platform)) throw new Error('Invalid messaging platform');
    await this.request('dashboard', `/api/messaging/platforms/${platform}`, {
      method: 'PUT', body: { profile: name, enabled },
    });
  }
  async createProfile(name: string): Promise<{ ok: boolean; name: string; path: string }> {
    const canonical = profileName(name);
    if (canonical === 'default') throw new Error('Default profile already exists');
    const response = await this.request('dashboard', '/api/profiles', { method: 'POST', body: { name: canonical } });
    const created = await response.json() as { ok: boolean; name: string; path: string };
    await this.ensureCredential(canonical);
    await this.ensureModelConfig(this.profileHome(canonical));
    await this.onProfileReady?.(canonical, this.profileHome(canonical));
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
  // Hermes v0.23.2: hermes_cli/web_routers/cron.py:776-849 and web_models.py:328-358.
  private cronPath(id?: string, profile?: string): string {
    const path = `/api/cron/jobs${id ? `/${encodeURIComponent(id)}` : ''}`;
    return profile ? `${path}?profile=${encodeURIComponent(profileName(profile))}` : path;
  }
  async listCron(profile?: string): Promise<Record<string, unknown>[]> {
    return this.request('dashboard', profile ? this.cronPath(undefined, profile) : '/api/cron/jobs')
      .then(async (r) => await r.json() as Record<string, unknown>[]);
  }
  async createCron(prompt: string, schedule: string, profile?: string, name?: string): Promise<{ id: string }> {
    return this.request('dashboard', this.cronPath(undefined, profile), { method: 'POST', body: { prompt, schedule, name } })
      .then(async (r) => await r.json() as { id: string });
  }
  async updateCron(id: string, changes: { prompt?: string; schedule?: string; name?: string }, profile?: string) {
    return this.request('dashboard', this.cronPath(id, profile), { method: 'PUT', body: { updates: changes } })
      .then(async (r) => await r.json());
  }
  async pauseCron(id: string, paused: boolean, profile?: string) {
    const path = this.cronPath(id, profile);
    const [url, query] = path.split('?');
    return this.request('dashboard', `${url}/${paused ? 'pause' : 'resume'}${query ? `?${query}` : ''}`, { method: 'POST' })
      .then(async (r) => await r.json());
  }
  async triggerCron(id: string, profile?: string) {
    const [url, query] = this.cronPath(id, profile).split('?');
    return this.request('dashboard', `${url}/trigger${query ? `?${query}` : ''}`, { method: 'POST' })
      .then(async (r) => await r.json());
  }
  async cronHistory(id: string, profile?: string) {
    // Hermes creates the profile's SessionDB on API server startup; the dashboard
    // history endpoint requires that store even for jobs with no previous runs.
    await this.server(profile ?? 'default');
    const [url, query] = this.cronPath(id, profile).split('?');
    return this.request('dashboard', `${url}/runs${query ? `?${query}&limit=20` : '?limit=20'}`)
      .then(async (r) => await r.json());
  }
  async deleteCron(id: string, profile?: string): Promise<{ ok: boolean }> {
    return this.request('dashboard', this.cronPath(id, profile), { method: 'DELETE' })
      .then(async (r) => await r.json() as { ok: boolean });
  }

  // Hermes v0.23.2: plugins/kanban/dashboard/plugin_api.py:357-455,690-713,1267-1275,1409-1452.
  private kanbanPath(path: string, workspace?: string): string {
    return `/api/plugins/kanban/${path}${workspace ? `?board=${encodeURIComponent(workspace)}` : ''}`;
  }
  async kanbanBoards() {
    return this.request('dashboard', this.kanbanPath('boards')).then(async (r) => await r.json());
  }
  async createKanbanBoard(slug: string, name?: string) {
    return this.request('dashboard', this.kanbanPath('boards'), { method: 'POST', body: { slug, name } })
      .then(async (r) => await r.json());
  }
  async kanbanBoard(workspace: string) {
    return this.request('dashboard', this.kanbanPath('board', workspace)).then(async (r) => await r.json());
  }
  async createKanbanTask(workspace: string, title: string, assignee: string, body?: string) {
    return this.request('dashboard', this.kanbanPath('tasks', workspace), {
      method: 'POST', body: { title, body, assignee },
    }).then(async (r) => await r.json());
  }
  async assignKanbanTask(workspace: string, id: string, assignee: string) {
    return this.request('dashboard', this.kanbanPath(`tasks/${encodeURIComponent(id)}`, workspace), {
      method: 'PATCH', body: { assignee },
    }).then(async (r) => await r.json());
  }
  async kanbanTask(workspace: string, id: string) {
    return this.request('dashboard', this.kanbanPath(`tasks/${encodeURIComponent(id)}`, workspace))
      .then(async (r) => await r.json());
  }
  async dispatchKanban(workspace: string) {
    return this.request('dashboard', this.kanbanPath('dispatch', workspace), { method: 'POST' })
      .then(async (r) => await r.json());
  }

  private skillPath(path: string, profile: string): string {
    return `${path}?profile=${encodeURIComponent(profileName(profile))}`;
  }

  async listSkills(profile: string): Promise<Record<string, unknown>[]> {
    return this.request('dashboard', this.skillPath('/api/skills', profile))
      .then(async (r) => await r.json() as Record<string, unknown>[]);
  }

  async officialSkills(profile: string): Promise<{ skills: Record<string, unknown>[] }> {
    return this.request('dashboard', this.skillPath('/api/skills/hub/official', profile))
      .then(async (r) => await r.json() as { skills: Record<string, unknown>[] });
  }

  async previewHubSkill(profile: string, identifier: string): Promise<{
    name: string; identifier: string; skill_md: string; files: string[];
  }> {
    if (!identifier || identifier.length > 500) throw new Error('Invalid Hub identifier');
    const path = `/api/skills/hub/preview?profile=${encodeURIComponent(profileName(profile))}&identifier=${encodeURIComponent(identifier)}`;
    // Isolated acceptance tests use a local HTTP fixture for the pinned read-only Hub seam.
    const fixture = process.env.NODE_ENV === 'test' ? process.env.NMH_HERMES_TEST_HUB_URL : undefined;
    const response = fixture ? fetch(new URL(path, fixture)) : this.request('dashboard', path);
    return response.then(async (r) => {
      if (!r.ok) throw new Error(`Hub preview returned HTTP ${r.status}`);
      return r.json() as Promise<{ name: string; identifier: string; skill_md: string; files: string[] }>;
    });
  }

  async scanHubSkill(profile: string, identifier: string): Promise<{ policy: string; findings: unknown[] }> {
    if (!identifier || identifier.length > 500) throw new Error('Invalid Hub identifier');
    const path = `/api/skills/hub/scan?profile=${encodeURIComponent(profileName(profile))}&identifier=${encodeURIComponent(identifier)}`;
    const fixture = process.env.NODE_ENV === 'test' ? process.env.NMH_HERMES_TEST_HUB_URL : undefined;
    const response = fixture ? fetch(new URL(path, fixture)) : this.request('dashboard', path);
    return response.then(async (r) => {
      if (!r.ok) throw new Error(`Hub scan returned HTTP ${r.status}`);
      return r.json() as Promise<{ policy: string; findings: unknown[] }>;
    });
  }

  async curatorStatus(profile: string): Promise<Record<string, unknown>> {
    return this.request('dashboard', this.skillPath('/api/curator', profile))
      .then(async (r) => await r.json() as Record<string, unknown>);
  }

  async pauseCurator(profile: string, paused: boolean): Promise<{ ok: boolean; paused: boolean }> {
    return this.request('dashboard', this.skillPath('/api/curator/paused', profile), {
      method: 'PUT', body: { paused },
    }).then(async (r) => await r.json() as { ok: boolean; paused: boolean });
  }

  async runCurator(profile: string): Promise<{ ok: boolean; pid: number; name: string }> {
    const result = await this.request('dashboard', this.skillPath('/api/curator/run', profile), { method: 'POST' })
      .then(async (r) => await r.json() as { ok: boolean; pid: number; name: string });
    if (result.ok && Number.isSafeInteger(result.pid) && result.pid > 0) {
      this.curatorPids.add(result.pid);
      if (this.stopped) await this.stopCurator(result.pid);
    }
    return result;
  }

  private async stopCurator(pid: number): Promise<void> {
    if (process.platform === 'win32') {
      await exec('taskkill.exe', ['/PID', String(pid), '/T', '/F']).catch(() => {});
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch { /* action finished */ }
    }
    this.curatorPids.delete(pid);
  }

  async learningGraph(profile: string): Promise<Record<string, unknown>> {
    return this.request('dashboard', this.skillPath('/api/learning/graph', profile))
      .then(async (r) => await r.json() as Record<string, unknown>);
  }

  async learn(profile: string, description: string): Promise<{ run_id: string }> {
    const home = this.profileHome(profile);
    if (!existsSync(home)) throw new Error(`Unknown Hermes profile: ${profile}`);
    // Use the pinned Hermes /learn prompt builder, also called by its CLI and gateway.
    const child = spawn(this.python, ['-c',
      'import sys; from agent.learn_prompt import build_learn_prompt; sys.stdout.write(build_learn_prompt(sys.stdin.read()))',
    ], {
      cwd: this.upstream, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...await hermesBaseEnvironment(), PYTHONPATH: this.upstream, HERMES_HOME: home,
        HERMES_DISABLE_LAZY_INSTALLS: '1', PYTHONDONTWRITEBYTECODE: '1' },
    });
    this.learnProcesses.add(child);
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => errors.push(chunk));
    const finished = new Promise<void>((done, reject) => {
      child.once('error', reject);
      child.once('close', (code) => code === 0 ? done() : reject(new Error(`Hermes learn prompt failed (${code}): ${Buffer.concat(errors).toString().slice(-500)}`)));
    });
    child.stdin?.end(description);
    try { await finished; } finally { this.learnProcesses.delete(child); }
    if (this.stopped) throw new Error('Hermes extension disabled');
    return this.startRun(profile, Buffer.concat(output).toString('utf8'));
  }

  async startRun(profile: string, input: string, options?: { instructions?: string; sessionId?: string }): Promise<{ run_id: string }> {
    const body = { input, instructions: options?.instructions, session_id: options?.sessionId };
    return this.request('api', '/v1/runs', { method: 'POST', profile, body }).then(async (r) => await r.json() as { run_id: string });
  }
  async runStatus(profile: string, runId: string): Promise<{ status: string; session_id?: string }> {
    const response = await this.request('api', `/v1/runs/${encodeURIComponent(runId)}`, { profile });
    return await response.json() as { status: string; session_id?: string };
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
    await Promise.all([...this.learnProcesses].map((child) => killTree(child)));
    await Promise.all([...this.curatorPids].map((pid) => this.stopCurator(pid)));
    await Promise.allSettled([...this.starting.values()]);
    await Promise.all([...this.api.keys()].map((profile) => this.stopProfile(profile)));
    if (this.dashboard) { await killTree(this.dashboard.child); this.dashboard = undefined; }
  }
}
