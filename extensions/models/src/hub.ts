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
export interface RoutedTask { text: string; ticketId?: string; source?: string }
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
  escalationLimits?(): EscalationLimits;
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
const scope = { kind: 'workspace' as const, workspaceId: 'default' };
const credentialName = (id: string) => `NEO_MODEL_${id.toUpperCase().replace(/-/g, '_')}_KEY`;
const hermesProfile = (name: string) => {
  const profile = name.trim().toLowerCase();
  if (profile !== 'default' && !/^[a-z][a-z0-9_-]{0,47}$/.test(profile)) {
    throw new Error('Invalid Hermes profile name');
  }
  return profile;
};

/** Neo-owned metadata and role routing. Secrets only ever enter the encrypted vault. */
export class ModelHub {
  active = false;
  private router?: ModelRouter;
  private settings: HubSettings;
  private pending: Promise<void> = Promise.resolve();
  private readonly projections = new Map<string, string>();
  private readonly filename: string;

  constructor(private readonly vault: VaultService, dataDir: string) {
    this.filename = join(dataDir, 'models', 'settings.json');
    this.settings = existsSync(this.filename)
      ? JSON.parse(readFileSync(this.filename, 'utf8')) as HubSettings : emptySettings();
  }

  setActive(value: boolean): void { this.active = value; }

  registerRouter(router: ModelRouter): () => void {
    if (this.router) throw new Error('A model router is already registered');
    this.router = router;
    return () => { if (this.router === router) this.router = undefined; };
  }

  state() {
    return {
      active: this.active,
      providers: this.settings.providers.map(({ id, name, baseUrl, hasKey }) => ({ id, kind: 'openai-compatible' as const, name, baseUrl, hasKey: !!hasKey })),
      roles: this.settings.roles,
      overrides: this.settings.overrides,
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

  private async persist(): Promise<void> {
    this.settings.revision++;
    const copy = JSON.stringify(this.settings, null, 2) + '\n';
    this.pending = this.pending.catch(() => {}).then(async () => {
      await mkdir(dirname(this.filename), { recursive: true });
      const temp = `${this.filename}.${randomUUID()}.tmp`;
      try { await writeFile(temp, copy, { mode: 0o600 }); await rename(temp, this.filename); }
      finally { await unlink(temp).catch(() => {}); }
    });
    await this.pending;
  }

  async saveProvider(input: { id: string; kind: 'openai-compatible'; name?: string; baseUrl: string; apiKey?: string }): Promise<ModelProvider> {
    if (!providerId.test(input.id)) throw new Error('Invalid provider ID');
    if (input.kind !== 'openai-compatible') throw new Error('Unsupported model provider kind');
    const url = new URL(input.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid model endpoint URL');
    const previous = this.settings.providers.find((item) => item.id === input.id);
    if (input.apiKey) await this.vault.put(scope, credentialName(input.id), input.apiKey);
    const record = { id: input.id, kind: 'openai-compatible' as const, name: input.name?.trim() || previous?.name || input.id, baseUrl: url.href.replace(/\/$/, ''), hasKey: Boolean(input.apiKey || previous?.hasKey) };
    this.settings.providers = [...this.settings.providers.filter((item) => item.id !== input.id), record];
    await this.persist();
    return record;
  }

  async deleteProvider(id: string): Promise<{ deleted: boolean }> {
    if (!this.settings.providers.some((item) => item.id === id)) return { deleted: false };
    this.settings.providers = this.settings.providers.filter((item) => item.id !== id);
    for (const role of MODEL_ROLES) if (this.settings.roles[role]?.providerId === id) delete this.settings.roles[role];
    for (const [bot, binding] of Object.entries(this.settings.overrides)) if (binding.providerId === id) delete this.settings.overrides[bot];
    await this.vault.delete(scope, credentialName(id));
    await this.persist();
    return { deleted: true };
  }

  async testProvider(id: string): Promise<{ ok: boolean; models: number; status: number }> {
    const provider = this.settings.providers.find((item) => item.id === id);
    if (!provider) throw new Error('Unknown provider');
    const key = await this.vault.get(scope, credentialName(id));
    const response = await fetch(provider.baseUrl + '/models', {
      headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(8000),
    });
    const body = response.ok ? await response.json() as { data?: unknown[] } : undefined;
    return { ok: response.ok, models: Array.isArray(body?.data) ? body.data.length : 0, status: response.status };
  }

  async setRole(input: { role: ModelRole; providerId: string; model: string }): Promise<{ role: ModelRole; selection: ModelSelection }> {
    if (!MODEL_ROLES.includes(input.role)) throw new Error('Unknown model role');
    const selection = this.validateSelection(input);
    this.settings.roles[input.role] = selection;
    await this.persist();
    return { role: input.role, selection };
  }

  async setOverride(input: { profile: string; providerId?: string; model?: string }): Promise<{ profile: string; selection: ModelSelection | null }> {
    const key = hermesProfile(input.profile);
    if (input.providerId && input.model) this.settings.overrides[key] = this.validateSelection({ providerId: input.providerId, model: input.model });
    else delete this.settings.overrides[key];
    await this.persist();
    return { profile: key, selection: this.settings.overrides[key] ?? null };
  }

  private validateSelection(input: ModelSelection): ModelSelection {
    if (!this.settings.providers.some((item) => item.id === input.providerId) || !input.model.trim()) {
      throw new Error('Model provider and model are required');
    }
    return { providerId: input.providerId, model: input.model.trim() };
  }

  async resolve(role: ModelRole, profile?: string, task?: RoutedTask): Promise<ResolvedModel> {
    if (!this.active) throw new Error('Model Hub extension is disabled');
    const override = profile ? this.settings.overrides[hermesProfile(profile)] : undefined;
    let selection = override ?? this.settings.roles[role];
    if (!selection) throw new Error(`Model role ${role} is unconfigured`);
    // Explicit profile overrides bypass automatic routing. Router failure preserves direct service.
    if (!override && this.router) {
      const router = this.router;
      try {
        const routed = await router.select(role, { ...selection }, task);
        if (this.active && this.router === router && routed?.model.trim()
          && this.settings.providers.some((item) => item.id === routed.providerId)) selection = routed;
      } catch { /* Direct binding is the fallback; never expose upstream errors or secrets. */ }
    }
    if (!this.active) throw new Error('Model Hub extension is disabled');
    const provider = this.settings.providers.find((item) => item.id === selection.providerId);
    if (!provider) throw new Error(`Model provider ${selection.providerId} is unavailable`);
    const apiKey = await this.vault.get(scope, credentialName(provider.id));
    return { ...selection, baseUrl: provider.baseUrl, ...(apiKey ? { apiKey } : {}) };
  }

  /** One task-scoped retry at the next configured tier. A detached router cannot extend a run. */
  async runRoutedTurn<T>(role: ModelRole, profile: string | undefined, task: RoutedTask,
    execute: (binding: ResolvedModel, context: { attempt: number; tier: ModelRole; signal: AbortSignal }) => Promise<T>,
    onAttempt?: (entry: RouteAttempt) => Promise<void>): Promise<T> {
    const router = this.router;
    const override = profile ? this.settings.overrides[hermesProfile(profile)] : undefined;
    const limits = override ? undefined : router?.escalationLimits?.();
    const tiers: Record<ModelRole, ModelRole[]> = {
      fast: ['fast', 'default', 'reasoning'], default: ['default', 'reasoning'],
      reasoning: ['reasoning'], coding: ['coding', 'reasoning'], eval: ['eval', 'reasoning'],
    };
    const maxAttempts = limits?.enabled ? Math.min(limits.maxAttempts, tiers[role].length) : 1;
    const started = Date.now();
    let failure: unknown;
    let previous: ModelSelection | undefined;
    for (let index = 0; index < maxAttempts; index++) {
      if (index > 0 && (this.router !== router || !this.settings.roles[tiers[role][index]])) break;
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
  async projectHermes(profile: string, home: string): Promise<string | undefined> {
    if (!this.active) return undefined;
    const canonical = hermesProfile(profile);
    const selection = this.settings.overrides[canonical] ?? this.settings.roles.default;
    if (!selection) return undefined;
    const binding = await this.resolve('default', canonical);
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
    const version = `${binding.providerId}/${binding.model}/${binding.baseUrl}/${this.settings.revision}`;
    this.projections.set(canonical, version);
    return version;
  }
}
