import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { HermesProjector, type VaultService } from '@neometaharness/vault';

export const MODEL_ROLES = ['default', 'fast', 'reasoning', 'coding', 'eval'] as const;
export type ModelRole = typeof MODEL_ROLES[number];

export interface ModelProvider {
  id: string;
  kind: 'openai-compatible';
  name: string;
  baseUrl: string;
  hasKey: boolean;
}
export interface ModelSelection { providerId: string; model: string }
/** workspace: whose provider keys, roles and router settings serve the task (P1-13); absent = deployment. */
export interface RoutedTask { text: string; ticketId?: string; source?: string; workspace?: string }
export interface RouteAttempt {
  task: RoutedTask;
  role: ModelRole;
  tier: ModelRole;
  attempt: number;
  selection: ModelSelection;
  latencyMs: number;
  outcome: 'accepted' | 'failed' | 'declined';
}
export interface EscalationLimits { enabled: boolean; maxAttempts: number; maxTotalMs: number }
/** The evaluator can distinguish a declined decision from a transport failure. */
export class ModelRouteRejected extends Error {}
/** Optional routing policy; credentials and endpoints remain owned by Model Hub. */
export interface ModelRouter {
  select(role: ModelRole, direct: ModelSelection, task?: RoutedTask): Promise<ModelSelection | undefined>;
  escalationLimits?(workspace?: string): EscalationLimits | Promise<EscalationLimits>;
  recordAttempt?(entry: RouteAttempt): Promise<void>;
}
export interface ResolvedModel extends ModelSelection { baseUrl: string; apiKey?: string }
type ProviderRecord = Omit<ModelProvider, 'hasKey'> & { hasKey?: boolean };
type HubSettings = {
  providers: ProviderRecord[];
  roles: Partial<Record<ModelRole, ModelSelection>>;
  overrides: Record<string, ModelSelection>;
  revision: number;
};

const emptySettings = (): HubSettings => ({ providers: [], roles: {}, overrides: {}, revision: 0 });
const providerId = /^[a-z][a-z0-9-]{0,47}$/;

/** Gateway service: which storage a caller's workspace maps to (desktop: always the one 'default'). */
export interface WorkspaceDirectory {
  key(workspace?: string): string;
  /** Server mode: the first workspace, which inherits configuration stored before P1-13. */
  bootstrap(): Promise<string | undefined>;
}
const DEPLOYMENT = 'default';
const workspaceKeyPattern = /^[A-Za-z0-9_-]{1,128}$/;
/**
 * Per-workspace storage (P1-13). 'default' is the deployment's: desktop's only one, and in server mode the
 * configuration of deployment-level work (Hermes profiles, registry evaluation). Each server workspace has its own.
 */
export class WorkspaceStorage {
  constructor(private readonly directory?: WorkspaceDirectory) {}
  key(workspace?: string): string {
    const key = this.directory ? this.directory.key(workspace) : workspace ?? DEPLOYMENT;
    if (!workspaceKeyPattern.test(key)) throw new Error('Invalid workspace');
    return key;
  }
  /** True when this workspace should start from the deployment's pre-P1-13 configuration. */
  async inheritsDeployment(key: string): Promise<boolean> {
    return key !== DEPLOYMENT && (await this.directory?.bootstrap()) === key;
  }
  scope(key: string) { return { kind: 'workspace' as const, workspaceId: key }; }
}
const credentialName = (id: string) => `NEO_MODEL_${id.toUpperCase().replace(/-/g, '_')}_KEY`;
const hermesProfile = (name: string) => {
  const profile = name.trim().toLowerCase();
  if (profile !== 'default' && !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(profile)) {
    throw new Error('Invalid Hermes profile name');
  }
  return profile;
};

/** Neo-owned metadata and role routing. Secrets only ever enter the encrypted vault. */
export class ModelHub {
  active = false;
  private router?: ModelRouter;
  private readonly workspaces = new Map<string, HubSettings>();
  private readonly loading = new Map<string, Promise<HubSettings>>();
  private pending: Promise<void> = Promise.resolve();
  private readonly projections = new Map<string, string>();
  private readonly filename: string;
  private readonly storage: WorkspaceStorage;

  constructor(private readonly vault: VaultService, private readonly dataDir: string, directory?: WorkspaceDirectory) {
    this.filename = join(dataDir, 'models', 'settings.json');
    this.storage = new WorkspaceStorage(directory);
    this.workspaces.set(DEPLOYMENT, existsSync(this.filename)
      ? JSON.parse(readFileSync(this.filename, 'utf8')) as HubSettings : emptySettings());
  }

  private file(key: string): string {
    return key === DEPLOYMENT ? this.filename : join(this.dataDir, 'models', 'workspaces', key, 'settings.json');
  }

  /** One workspace's providers, roles and overrides; the bootstrap workspace starts from the deployment's. */
  private async settingsOf(workspace?: string): Promise<{ key: string; settings: HubSettings }> {
    const key = this.storage.key(workspace);
    const loaded = this.workspaces.get(key);
    if (loaded) return { key, settings: loaded };
    let load = this.loading.get(key);
    if (!load) {
      load = (async () => {
        const raw = await readFile(this.file(key), 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (raw !== undefined) return JSON.parse(raw) as HubSettings;
        if (!(await this.storage.inheritsDeployment(key))) return emptySettings();
        const inherited = structuredClone(this.workspaces.get(DEPLOYMENT)!);
        for (const provider of inherited.providers) {
          const secret = await this.vault.get(this.storage.scope(DEPLOYMENT), credentialName(provider.id));
          if (secret !== undefined) await this.vault.put(this.storage.scope(key), credentialName(provider.id), secret);
        }
        inherited.revision = 0;
        return inherited;
      })();
      this.loading.set(key, load);
    }
    try {
      const settings = await load;
      if (!this.workspaces.has(key)) this.workspaces.set(key, settings);
      return { key, settings: this.workspaces.get(key)! };
    } finally {
      this.loading.delete(key);
    }
  }

  setActive(value: boolean): void { this.active = value; }

  registerRouter(router: ModelRouter): () => void {
    if (this.router) throw new Error('A model router is already registered');
    this.router = router;
    return () => { if (this.router === router) this.router = undefined; };
  }

  async state(workspace?: string) {
    const { settings } = await this.settingsOf(workspace);
    return {
      active: this.active,
      providers: settings.providers.map(({ id, name, baseUrl, hasKey }) => ({ id, kind: 'openai-compatible' as const, name, baseUrl, hasKey: !!hasKey })),
      roles: settings.roles,
      overrides: settings.overrides,
    };
  }

  /** Reads provider ids/names from Hermes' pinned registry, including its OAuth entries. */
  catalog(): { id: string; name: string }[] {
    const root = resolve(import.meta.dirname ?? dirname(new URL(import.meta.url).pathname), '../../..');
    const lock = JSON.parse(readFileSync(join(root, 'upstream.lock.json'), 'utf8')) as { pins: Record<string, { ref: string }> };
    let cache = process.env.NMH_UPSTREAM_CACHE;
    if (!cache) {
      for (let folder = root; ; folder = dirname(folder)) {
        const candidate = join(folder, 'nmh-upstream-cache');
        if (existsSync(candidate)) { cache = candidate; break; }
        if (dirname(folder) === folder) throw new Error('Set NMH_UPSTREAM_CACHE to the pinned upstream cache');
      }
    }
    const file = join(cache, `hermes-agent@${lock.pins['hermes-agent']!.ref}`, 'hermes_cli', 'auth.py');
    const registry = readFileSync(file, 'utf8').split('_REGISTRY_ROWS:')[1]?.split('from hermes_cli.auth_plugin_providers')[0];
    if (!registry) throw new Error('Pinned Hermes registry format changed');
    const matches = registry.matchAll(/(?:^\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"|ProviderConfig\(\s*"([^"]+)"\s*,\s*"([^"]+)")/gm);
    return [...matches].map((match) => ({ id: match[1] ?? match[3]!, name: match[2] ?? match[4]! }));
  }

  private async persist(key: string): Promise<void> {
    const settings = this.workspaces.get(key)!;
    settings.revision++;
    const copy = JSON.stringify(settings, null, 2) + '\n';
    const filename = this.file(key);
    this.pending = this.pending.catch(() => {}).then(async () => {
      await mkdir(dirname(filename), { recursive: true });
      const temp = `${filename}.${randomUUID()}.tmp`;
      try { await writeFile(temp, copy, { mode: 0o600 }); await rename(temp, filename); }
      finally { await unlink(temp).catch(() => {}); }
    });
    await this.pending;
  }

  async saveProvider(input: { id: string; kind: 'openai-compatible'; name?: string; baseUrl: string; apiKey?: string }, workspace?: string): Promise<ModelProvider> {
    if (!providerId.test(input.id)) throw new Error('Invalid provider ID');
    if (input.kind !== 'openai-compatible') throw new Error('Unsupported model provider kind');
    const url = new URL(input.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid model endpoint URL');
    const { key, settings } = await this.settingsOf(workspace);
    const previous = settings.providers.find((item) => item.id === input.id);
    if (input.apiKey) await this.vault.put(this.storage.scope(key), credentialName(input.id), input.apiKey);
    const record = { id: input.id, kind: 'openai-compatible' as const, name: input.name?.trim() || previous?.name || input.id, baseUrl: url.href.replace(/\/$/, ''), hasKey: Boolean(input.apiKey || previous?.hasKey) };
    settings.providers = [...settings.providers.filter((item) => item.id !== input.id), record];
    await this.persist(key);
    return record;
  }

  async deleteProvider(id: string, workspace?: string): Promise<{ deleted: boolean }> {
    const { key, settings } = await this.settingsOf(workspace);
    if (!settings.providers.some((item) => item.id === id)) return { deleted: false };
    settings.providers = settings.providers.filter((item) => item.id !== id);
    for (const role of MODEL_ROLES) if (settings.roles[role]?.providerId === id) delete settings.roles[role];
    for (const [bot, binding] of Object.entries(settings.overrides)) if (binding.providerId === id) delete settings.overrides[bot];
    await this.vault.delete(this.storage.scope(key), credentialName(id));
    await this.persist(key);
    return { deleted: true };
  }

  async testProvider(id: string, workspace?: string): Promise<{ ok: boolean; models: number; status: number }> {
    const { key: storageKey, settings } = await this.settingsOf(workspace);
    const provider = settings.providers.find((item) => item.id === id);
    if (!provider) throw new Error('Unknown provider');
    const key = await this.vault.get(this.storage.scope(storageKey), credentialName(id));
    const response = await fetch(provider.baseUrl + '/models', {
      headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(8000),
    });
    const body = response.ok ? await response.json() as { data?: unknown[] } : undefined;
    return { ok: response.ok, models: Array.isArray(body?.data) ? body.data.length : 0, status: response.status };
  }

  async setRole(input: { role: ModelRole; providerId: string; model: string }, workspace?: string): Promise<{ role: ModelRole; selection: ModelSelection }> {
    if (!MODEL_ROLES.includes(input.role)) throw new Error('Unknown model role');
    const { key, settings } = await this.settingsOf(workspace);
    const selection = this.validateSelection(settings, input);
    settings.roles[input.role] = selection;
    await this.persist(key);
    return { role: input.role, selection };
  }

  async setOverride(input: { profile: string; providerId?: string; model?: string }, workspace?: string): Promise<{ profile: string; selection: ModelSelection | null }> {
    const key = hermesProfile(input.profile);
    const { key: storageKey, settings } = await this.settingsOf(workspace);
    if (input.providerId && input.model) settings.overrides[key] = this.validateSelection(settings, { providerId: input.providerId, model: input.model });
    else delete settings.overrides[key];
    await this.persist(storageKey);
    return { profile: key, selection: settings.overrides[key] ?? null };
  }

  private validateSelection(settings: HubSettings, input: ModelSelection): ModelSelection {
    if (!settings.providers.some((item) => item.id === input.providerId) || !input.model.trim()) {
      throw new Error('Model provider and model are required');
    }
    return { providerId: input.providerId, model: input.model.trim() };
  }

  /** workspace (or task.workspace) picks whose bindings and keys serve; absent = the deployment's. */
  async resolve(role: ModelRole, profile?: string, task?: RoutedTask, workspace = task?.workspace): Promise<ResolvedModel> {
    if (!this.active) throw new Error('Model Hub extension is disabled');
    const { key, settings } = await this.settingsOf(workspace);
    const override = profile ? settings.overrides[hermesProfile(profile)] : undefined;
    let selection = override ?? settings.roles[role];
    if (!selection) throw new Error(`Model role ${role} is unconfigured`);
    // Explicit profile overrides bypass automatic routing. Router failure preserves direct service.
    if (!override && this.router) {
      const router = this.router;
      try {
        const routed = await router.select(role, { ...selection }, { text: '', ...task, workspace });
        if (this.active && this.router === router && routed?.model.trim()
          && settings.providers.some((item) => item.id === routed.providerId)) selection = routed;
      } catch { /* Direct binding is the fallback; never expose upstream errors or secrets. */ }
    }
    if (!this.active) throw new Error('Model Hub extension is disabled');
    const provider = settings.providers.find((item) => item.id === selection.providerId);
    if (!provider) throw new Error(`Model provider ${selection.providerId} is unavailable`);
    const apiKey = await this.vault.get(this.storage.scope(key), credentialName(provider.id));
    return { ...selection, baseUrl: provider.baseUrl, ...(apiKey ? { apiKey } : {}) };
  }

  /** One task-scoped retry at the next configured tier. A detached router cannot extend a run. */
  async runRoutedTurn<T>(role: ModelRole, profile: string | undefined, task: RoutedTask,
    execute: (binding: ResolvedModel, context: { attempt: number; tier: ModelRole; signal: AbortSignal }) => Promise<T>,
    onAttempt?: (entry: RouteAttempt) => Promise<void>): Promise<T> {
    const router = this.router;
    const { settings } = await this.settingsOf(task.workspace);
    const override = profile ? settings.overrides[hermesProfile(profile)] : undefined;
    const limits = override ? undefined : await router?.escalationLimits?.(task.workspace);
    const tiers: Record<ModelRole, ModelRole[]> = {
      fast: ['fast', 'default', 'reasoning'], default: ['default', 'reasoning'],
      reasoning: ['reasoning'], coding: ['coding', 'reasoning'], eval: ['eval', 'reasoning'],
    };
    const maxAttempts = limits?.enabled ? Math.min(limits.maxAttempts, tiers[role].length) : 1;
    const started = Date.now();
    let failure: unknown;
    let previous: ModelSelection | undefined;
    for (let index = 0; index < maxAttempts; index++) {
      if (index > 0 && (this.router !== router || !settings.roles[tiers[role][index]])) break;
      const remaining = limits?.enabled ? limits.maxTotalMs - (Date.now() - started) : undefined;
      if (remaining !== undefined && remaining <= 0) break;
      const tier = tiers[role][index];
      const binding = await this.resolve(tier, profile, task);
      if (previous && previous.providerId === binding.providerId && previous.model === binding.model) break;
      previous = { providerId: binding.providerId, model: binding.model };
      const controller = new AbortController();
      const timer = remaining === undefined ? undefined : setTimeout(() => controller.abort(), remaining);
      const attemptStarted = Date.now();
      let outcome: RouteAttempt['outcome'] = 'failed';
      try {
        const result = await execute(binding, { attempt: index + 1, tier, signal: controller.signal });
        outcome = 'accepted';
        return result;
      } catch (error) {
        failure = error;
        if (error instanceof ModelRouteRejected) outcome = 'declined';
        if (index + 1 >= maxAttempts || controller.signal.aborted) throw error;
      } finally {
        if (timer) clearTimeout(timer);
        const entry: RouteAttempt = { task, role, tier, attempt: index + 1,
          selection: previous, latencyMs: Date.now() - attemptStarted, outcome };
        if (this.router === router) await router?.recordAttempt?.(entry);
        await onAttempt?.(entry);
      }
    }
    throw failure ?? new Error('Model escalation budget exhausted');
  }

  /** Project only Hermes' model keys and its Neo-managed .env block into an isolated profile. */
  /** Hermes profiles are deployment-level (one Hermes runtime per deployment), so they use the deployment's models. */
  async projectHermes(profile: string, home: string): Promise<string | undefined> {
    if (!this.active) return undefined;
    const canonical = hermesProfile(profile);
    const deployment = this.workspaces.get(DEPLOYMENT)!;
    const selection = deployment.overrides[canonical] ?? deployment.roles.default;
    if (!selection) return undefined;
    const binding = await this.resolve('default', canonical, undefined, DEPLOYMENT);
    await mkdir(home, { recursive: true });
    const configFile = join(home, 'config.yaml');
    const original = await readFile(configFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const config = (parse(original || '{}') ?? {}) as Record<string, unknown>;
    const model = { ...(typeof config.model === 'object' && config.model ? config.model : {}) } as Record<string, unknown>;
    delete model.base_url;
    delete model.key_env;
    delete model.api_key;
    delete model.api_key_env;
    config.model = { ...model, provider: 'neo_model', default: binding.model };
    const providers = { ...(typeof config.providers === 'object' && config.providers ? config.providers : {}) };
    config.providers = { ...providers, neo_model: { base_url: binding.baseUrl, key_env: 'NEO_MODEL_API_KEY' } };
    const updated = stringify(config);
    if (original !== updated) await writeFile(configFile, updated, 'utf8');
    await new HermesProjector(resolve(home), ['NEO_MODEL_API_KEY']).project(new Map([
      ['NEO_MODEL_API_KEY', binding.apiKey ?? 'local-no-key'],
    ]));
    const version = `${binding.providerId}/${binding.model}/${binding.baseUrl}/${deployment.revision}`;
    this.projections.set(canonical, version);
    return version;
  }
}
