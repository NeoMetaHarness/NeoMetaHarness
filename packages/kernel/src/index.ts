import { ExtensionGeneration } from './generation.js';
import { Context } from '@deepseek-ai/cordis';
import semver from 'semver';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseProvider, ExtensionInstall } from '@neometaharness/db';
import type { ExtensionStatus, GatewayEvent } from '@neometaharness/contracts';
import type { ComputerNotice } from '@neometaharness/computers';
import { coerceSettingValues, dependencyProblem, loadManifest, resolveOrder, type LocatedExtension, type ExtensionSettingsSchema } from './manifest.js';
import { ExtensionProcess } from './process.js';
import { ExtensionInstalls } from './install.js';
import { managedCordisEntry, managedProcessCommand, pinCordisResolution } from './managed-runtime.js';
export { extensionIntegrity } from './install.js';
export { ComputerMcpBridge, type ComputerMcpConfig, type ComputerMcpProjection } from './computer-mcp.js';
export { SkillsBridge, type SkillProjection } from './skills.js';
export { approveHttpsEgress, systemEgressResolver, type EgressResolver } from './egress.js';

export { coerceSettingValues, dependencyProblem, loadManifest, resolveOrder, SettingsValidationError, validateSettings } from './manifest.js';
export type { ExtensionManifest, LocatedExtension, ExtensionSettingsSchema, SettingPropertySchema, SettingPropertyType } from './manifest.js';

export type RouteHandler = (input: { method: string; body?: unknown; signal?: AbortSignal }) => unknown | Promise<unknown>;
export type Health = { ok: boolean; pid?: number };

export interface ExtensionContext {
  readonly signal: AbortSignal;
  provide(name: string, value: unknown): void;
  inject<T = unknown>(name: string): T | undefined;
  effect(register: () => () => void | Promise<void>): void;
  route(path: string, handler: RouteHandler): void;
  contribute(kind: string, value: { id: string; [key: string]: unknown }): void;
  /** Close owned sockets/connections when retiring, before request drain. */
  onDrain(close: () => void | Promise<void>): () => void;
  health(check: () => Health | Promise<Health>): void;
}

export interface NeoExtension {
  activate(context: ExtensionContext): void | Promise<void>;
}

export function defineExtension(extension: NeoExtension): NeoExtension {
  return extension;
}

function secretNameForKey(key: string): string {
  const sanitized = key.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
  return `SEC_${sanitized}`.slice(0, 128);
}

export class GatewayEvents {
  private nextSeq = 0;
  private readonly history: GatewayEvent[] = [];
  private readonly listeners = new Set<(event: GatewayEvent) => void>();

  publish(extensionId: string, status: ExtensionStatus['status']): void {
    const event: GatewayEvent = { seq: ++this.nextSeq, extensionId, status, type: 'extension.state' };
    this.history.push(event);
    if (this.history.length > 1000) this.history.shift();
    for (const listener of this.listeners) listener(event);
  }

  publishUpgrade(extensionId: string, previousVersion: string, version: string): void {
    const event: GatewayEvent = { seq: ++this.nextSeq, extensionId, previousVersion, version, type: 'extension.upgrade' };
    this.history.push(event);
    if (this.history.length > 1000) this.history.shift();
    for (const listener of this.listeners) listener(event);
  }

  publishSettings(extension: string, values: Record<string, unknown>, workspaceId?: string): void {
    const event: GatewayEvent = { seq: ++this.nextSeq, extension, type: 'settings.change', values,
      ...(workspaceId ? { workspaceId } : {}) };
    this.history.push(event);
    if (this.history.length > 1000) this.history.shift();
    for (const listener of this.listeners) listener(event);
  }

  publishComputer(notice: ComputerNotice): void {
    const event: GatewayEvent = { seq: ++this.nextSeq, ...notice };
    this.history.push(event);
    if (this.history.length > 1000) this.history.shift();
    for (const listener of this.listeners) listener(event);
  }

  async *subscribe(since = 0, signal?: AbortSignal): AsyncGenerator<GatewayEvent> {
    const queue = this.history.filter((event) => event.seq > since);
    let wake: (() => void) | undefined;
    const receive = (event: GatewayEvent): void => { queue.push(event); wake?.(); };
    const abort = (): void => { wake?.(); };
    this.listeners.add(receive);
    signal?.addEventListener('abort', abort);
    try {
      while (!signal?.aborted) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        await new Promise<void>((resolveWake) => { wake = resolveWake; });
        wake = undefined;
      }
    } finally {
      this.listeners.delete(receive);
      signal?.removeEventListener('abort', abort);
    }
  }
}

interface Entry {
  desired: boolean;
  status: ExtensionStatus['status'];
  reason?: string;
  running?: ExtensionGeneration;
}

/** A small Cordis facade. Each Cordis activation owns its routes, contributions and services. */
export class NeoKernel {
  readonly events = new GatewayEvents();
  private readonly discovered = new Map<string, LocatedExtension>();
  private readonly bundled = new Map<string, LocatedExtension>();
  private readonly stored = new Set<string>();
  private readonly installProblems = new Map<string, string>();
  private readonly installs: ExtensionInstalls;
  private readonly entries = new Map<string, Entry>();
  private readonly active = new Map<string, ExtensionGeneration>();
  private snapshot = {
    routes: new Map<string, { generation: ExtensionGeneration; handler: RouteHandler }>(),
    contributions: new Map<string, { id: string; [key: string]: unknown }>(),
    services: new Map<string, unknown>(),
    serviceOwners: new Map<string, string>(),
  };
  private validatePendingPublication?: () => void;
  private readonly pendingRestarts = new Set<string>();
  private readonly retirements = new Set<Promise<unknown>>();
  private closing = false;
  private readonly workspaceScope = new AsyncLocalStorage<string | undefined>();
  private readonly fallbackWorkspace: string | undefined;
  /** Pre-P1-13 settings have moved (or there is nowhere to move them from). */
  private legacyMigrated = true;
  private legacyRun?: Promise<void>;
  private operation: Promise<unknown> = Promise.resolve();
  private order: string[] = [];

  constructor(private readonly db: DatabaseProvider, private readonly services: Readonly<Record<string, unknown>> = {},
    private readonly dataDir?: string, private readonly pythonExecutable?: string, private readonly options: KernelOptions = {}) {
    this.installs = new ExtensionInstalls(dataDir, pythonExecutable);
    this.fallbackWorkspace = options.fallbackWorkspace === null ? undefined : options.fallbackWorkspace ?? 'default';
  }

  async discover(root: string): Promise<void> {
    for (const dirent of await readdir(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const directory = resolve(root, dirent.name);
      try {
        const manifest = await loadManifest(directory);
        if (this.discovered.has(manifest.id)) throw new Error(`Duplicate extension id: ${manifest.id}`);
        this.discovered.set(manifest.id, { manifest, directory });
        this.bundled.set(manifest.id, { manifest, directory });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await this.db.migrate();
    const installs = this.db.listExtensionInstalls ? await this.db.listExtensionInstalls()
      : (await Promise.all([...this.discovered.keys()].map(async (id) => {
        const value = await this.db.getExtensionInstall?.(id); return value ? { id, ...value } : undefined;
      }))).filter((value): value is ExtensionInstall => !!value);
    for (const installed of installs) {
      const { id } = installed;
      const bundled = this.bundled.get(id);
      if (bundled && semver.valid(installed.version) && semver.gte(bundled.manifest.version, installed.version)) {
        await this.db.deleteExtensionInstall?.(id);
        continue;
      }
      this.stored.add(id);
      try {
        const located = await this.installs.restore(installed);
        resolveOrder(new Map(this.discovered).set(id, located));
        this.discovered.set(id, located);
      } catch (error) {
        this.installProblems.set(id, `Installed extension ${id}@${installed.version} unavailable: ${(error as Error).message}${
          bundled ? `; using bundled ${bundled.manifest.version}` : ''}`);
      }
    }
    this.order = resolveOrder(this.discovered);
    this.legacyMigrated = false;
    await this.ensureLegacyMigrated();
    for (const id of this.order) {
      this.entries.set(id, { desired: await this.db.getEnabled(id), status: 'disabled' });
    }
    for (const [id, reason] of this.installProblems) {
      if (!this.entries.has(id)) this.entries.set(id, { desired: await this.db.getEnabled(id), status: 'degraded', reason });
    }
    await this.reconcile();
  }

  list(): ExtensionStatus[] {
    return [...this.entries.keys()].map((id) => this.status(id));
  }

  status(id: string): ExtensionStatus {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown extension: ${id}`);
    const manifest = this.discovered.get(id)?.manifest;
    return {
      id, version: manifest?.version,
      desired: entry.desired,
      status: entry.status,
      ...(entry.reason ? { reason: entry.reason } : {}),
      routes: this.routesFor(id),
      ...(manifest?.settings ? { settings: manifest.settings } : {}),
    };
  }

  async health(id: string): Promise<Health | undefined> {
    return this.entries.get(id)?.running?.check();
  }

  enable(id: string): Promise<ExtensionStatus> { return this.setEnabled(id, true); }
  disable(id: string): Promise<ExtensionStatus> { return this.setEnabled(id, false); }
  uninstall(id: string): Promise<ExtensionStatus> { return this.setEnabled(id, false, true); }

  /** Stage and health-check a local immutable version; old registrations remain live until commit. */
  upgrade(id: string, directory: string, options: { integrity: string; healthTimeoutMs?: number; drainTimeoutMs?: number }): Promise<{
    extension: ExtensionStatus; previousVersion: string; upgraded: boolean; reason?: string;
  }> {
    const work = this.operation.then(async () => {
      const entry = this.entries.get(id);
      const previous = this.discovered.get(id);
      if (!entry || !previous) throw new Error(`Unknown extension: ${id}`);
      const old = entry.running;
      let candidate: ExtensionGeneration | undefined;
      let dependents: ExtensionGeneration[] = [];
      try {
        if (!old || !entry.desired) throw new Error('Enable the extension before upgrading');
        if (!this.db.setExtensionInstall || !this.db.deleteExtensionInstall) throw new Error('Database provider does not support installed extension versions');
        const located = await this.installs.copy(id, directory, options.integrity, previous);
        const { manifest } = located;
        const prospective = new Map(this.discovered).set(id, located);
        const order = resolveOrder(prospective);
        for (const value of prospective.values()) {
          const problem = dependencyProblem(value.manifest, prospective);
          if (problem && (value.manifest.id === id || this.entries.get(value.manifest.id)?.desired)) throw new Error(problem);
        }
        for (const dependency of Object.keys(manifest.dependsOn ?? {})) {
          if (!this.entries.get(dependency)?.running) throw new Error(`Dependency ${dependency} is not running`);
        }
        candidate = new ExtensionGeneration(id);
        await deadline(this.start(id, located, candidate, true), options.healthTimeoutMs ?? 5000, 'Extension activation timed out');
        const health = await deadline(candidate.check(), options.healthTimeoutMs ?? 5000, 'Extension health check timed out');
        if (health.ok !== true) throw new Error('Candidate extension is unhealthy');
        let snapshot: typeof this.snapshot;
        const prepare = () => {
          dependents = this.runningDependents(id);
          const next = new Map(this.active).set(id, candidate!);
          for (const dependent of dependents) next.delete(dependent.id);
          snapshot = this.compile(next);
        };
        prepare();
        this.validatePendingPublication = prepare;
        candidate.changed = prepare;
        await this.db.setExtensionInstall(id, { directory: located.directory, version: manifest.version, integrity: options.integrity });
        for (const dependent of dependents) {
          this.active.delete(dependent.id);
          this.entries.get(dependent.id)!.running = undefined;
          this.pendingRestarts.add(dependent.id);
        }
        this.publish(id, candidate, snapshot!);
        this.discovered.set(id, located); this.order = order; entry.running = candidate;
        this.stored.add(id); this.installProblems.delete(id);
      } catch (error) {
        this.validatePendingPublication = undefined;
        if (candidate) await candidate.dispose(0).catch(() => {});
        return { extension: this.status(id), previousVersion: previous.manifest.version, upgraded: false, reason: (error as Error).message };
      } finally {
        this.validatePendingPublication = undefined;
      }
      this.setStatus(id, 'running');
      for (const dependent of dependents) this.setStatus(dependent.id, 'degraded', `Restarting after upgrade of ${id}`);
      this.events.publishUpgrade(id, previous.manifest.version, this.discovered.get(id)!.manifest.version);
      const extension = this.status(id);
      const retirement = this.finishUpgrade(old!, dependents, options.drainTimeoutMs ?? 5000);
      this.retirements.add(retirement);
      void retirement.then(() => this.retirements.delete(retirement), () => this.retirements.delete(retirement));
      return { extension, previousVersion: previous.manifest.version, upgraded: true, retirement };
    });
    this.operation = work.catch(() => {});
    return work.then(async ({ retirement, ...result }) => {
      try { if (await retirement) return { ...result, reason: 'Upgrade committed; old generation cleanup failed' }; }
      catch { return { ...result, reason: 'Upgrade committed; dependent reconciliation failed' }; }
      return result;
    });
  }

  private runningDependents(id: string): ExtensionGeneration[] {
    const affected = new Set([id]);
    for (;;) {
      const count = affected.size;
      for (const [name, generation] of this.active) {
        const declared = Object.keys(this.discovered.get(name)!.manifest.dependsOn ?? {});
        if ([...declared, ...generation.injectedFrom].some(dependency => affected.has(dependency))) affected.add(name);
      }
      if (count === affected.size) break;
    }
    return [...this.active.values()].reverse().filter(generation => generation.id !== id && affected.has(generation.id));
  }

  private async finishUpgrade(old: ExtensionGeneration, dependents: ExtensionGeneration[], drainMs: number): Promise<boolean> {
    let cleanupFailed = false;
    for (const generation of [...dependents, old]) {
      try { await generation.dispose(drainMs); } catch { cleanupFailed = true; }
    }
    if (dependents.length && !this.closing) {
      const work = this.operation.then(async () => {
        for (const dependent of dependents) this.pendingRestarts.delete(dependent.id);
        if (!this.closing) await this.reconcile();
      });
      this.operation = work.catch(() => {});
      await work;
    }
    return cleanupFailed;
  }

  private setEnabled(id: string, enabled: boolean, uninstall = false): Promise<ExtensionStatus> {
    const work = this.operation.then(async () => {
      const entry = this.entries.get(id);
      if (!entry) throw new Error(`Unknown extension: ${id}`);
      let remove = false;
      if (uninstall) {
        if (!this.stored.has(id)) throw new Error(`No managed install for extension: ${id}`);
        if (!this.db.deleteExtensionInstall) throw new Error('Database provider cannot remove installed extension versions');
        await this.db.deleteExtensionInstall(id);
        this.stored.delete(id);
        this.installProblems.delete(id);
        const bundled = this.bundled.get(id);
        if (bundled) this.discovered.set(id, bundled);
        else remove = true;
        if (bundled) this.order = resolveOrder(this.discovered);
      }
      await this.db.setEnabled(id, enabled);
      entry.desired = enabled;
      await this.reconcile();
      if (remove) {
        this.discovered.delete(id);
        this.order = resolveOrder(this.discovered);
      }
      if (this.discovered.has(id) || this.installProblems.has(id)) return this.status(id);
      this.setStatus(id, 'disabled');
      const status = this.status(id);
      this.entries.delete(id);
      return status;
    });
    this.operation = work.catch(() => {});
    return work;
  }

  private setStatus(id: string, status: Entry['status'], reason?: string): void {
    const entry = this.entries.get(id)!;
    const changed = entry.status !== status || entry.reason !== reason;
    entry.status = status;
    entry.reason = reason;
    if (changed) this.events.publish(id, status);
  }

  private async reconcile(): Promise<void> {
    const eligible = new Map<string, boolean>();
    const problems = new Map<string, string>();
    for (const id of this.order) {
      const entry = this.entries.get(id)!;
      const manifest = this.discovered.get(id)!.manifest;
      const problem = dependencyProblem(manifest, this.discovered)
        ?? Object.keys(manifest.dependsOn ?? {}).filter((dependency) => !eligible.get(dependency)).map((dependency) => `Dependency ${dependency} is disabled or degraded`)[0];
      if (problem) problems.set(id, problem);
      eligible.set(id, entry.desired && !problem && !this.pendingRestarts.has(id));
    }

    // Descendants stop before their providers, which avoids dangling injections.
    for (const id of [...this.order].reverse()) {
      const entry = this.entries.get(id)!;
      if (entry.running && !eligible.get(id)) {
        await this.retire(id, entry.running);
        entry.running = undefined;
      }
    }

    for (const id of this.order) {
      const entry = this.entries.get(id)!;
      if (!entry.desired) {
        const installProblem = this.installProblems.get(id);
        this.setStatus(id, installProblem ? 'degraded' : 'disabled', installProblem);
        continue;
      }
      if (this.pendingRestarts.has(id)) continue;
      const runtimeProblem = problems.get(id)
        ?? Object.keys(this.discovered.get(id)!.manifest.dependsOn ?? {})
          .filter((dependency) => !this.entries.get(dependency)?.running)
          .map((dependency) => `Dependency ${dependency} is not running`)[0];
      if (runtimeProblem) {
        if (entry.running) {
          await this.retire(id, entry.running);
          entry.running = undefined;
        }
        this.setStatus(id, 'degraded', runtimeProblem);
        continue;
      }
      if (!entry.running) {
        try {
          const generation = await this.start(id);
          try { this.publish(id, generation); entry.running = generation; }
          catch (error) { await generation.dispose(0); throw error; }
        } catch (error) {
          this.setStatus(id, 'degraded', (error as Error).message);
          continue;
        }
      }
      const installProblem = this.installProblems.get(id);
      this.setStatus(id, installProblem ? 'degraded' : 'running', installProblem);
    }
  }

  private compile(active: ReadonlyMap<string, ExtensionGeneration>) {
    const routes = new Map<string, { generation: ExtensionGeneration; handler: RouteHandler }>();
    const contributions = new Map<string, { id: string; [key: string]: unknown }>();
    const services = new Map<string, unknown>();
    const serviceOwners = new Map<string, string>();
    for (const generation of active.values()) {
      for (const [path, handler] of generation.routes) {
        if (routes.has(path)) throw new Error(`Duplicate route ${path}`);
        routes.set(path, { generation, handler });
      }
      for (const [key, value] of generation.contributions) {
        if (contributions.has(key)) throw new Error(`Duplicate contribution ${key}`);
        contributions.set(key, value);
      }
      for (const [name, value] of generation.services) {
        if (services.has(name)) throw new Error(`Duplicate service ${name}`);
        services.set(name, value);
        serviceOwners.set(name, generation.id);
      }
    }
    return { routes, contributions, services, serviceOwners };
  }

  private publish(id: string, generation: ExtensionGeneration, snapshot = this.compile(new Map(this.active).set(id, generation))) {
    this.active.set(id, generation);
    this.snapshot = snapshot; // One synchronous pointer swap publishes all registrations.
    generation.changed = () => {
      if (this.active.get(id) === generation) {
        const next = this.compile(this.active);
        this.validatePendingPublication?.();
        this.snapshot = next;
      }
    };
  }

  private async retire(id: string, generation: ExtensionGeneration) {
    if (this.active.get(id) === generation) {
      this.active.delete(id); this.snapshot = this.compile(this.active);
    }
    await generation.dispose();
  }

  contributionIds(): string[] { return [...this.snapshot.contributions.keys()]; }
  async invokeRoute(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<unknown | undefined> {
    let route = this.snapshot.routes.get(path);
    if (!route) return undefined;
    // runInWorkspace preloads the generations active when the request began. A generation that became active
    // since (blue/green switch) loads the request's workspace here, before its handler reads settings. The load
    // is async, so the route may switch generation again meanwhile: re-resolve it and load for the new one.
    const workspaceId = this.workspaceScope.getStore();
    for (let attempts = 0; workspaceId && workspaceId !== this.fallbackWorkspace && attempts < 8
      && !this.options.deploymentSettings?.(route.generation.id) && route.generation.settingsSchema && !route.generation.workspaceSettings.has(workspaceId); attempts++) {
      await this.generationSettings(route.generation.id, route.generation, workspaceId);
      const current = this.snapshot.routes.get(path);
      if (!current) return undefined;
      route = current;
    }
    return route.generation.invoke(route.handler, method, body, signal);
  }
  hasRoute(path: string): boolean { return this.snapshot.routes.has(path); }
  routesFor(id: string): string[] { return [...this.snapshot.routes.keys()].filter((route) => route.startsWith(`/x/${id}/`)); }

  hasExtension(id: string): boolean {
    return this.discovered.has(id);
  }

  getSettingsSchema(id: string): ExtensionSettingsSchema | undefined {
    return structuredClone(this.active.get(id)?.settingsSchema ?? this.discovered.get(id)?.manifest.settings);
  }

  /** The workspace whose settings apply right now: the request's (runInWorkspace), else the fallback one. */
  currentWorkspace(): string | undefined {
    return this.workspaceScope.getStore() ?? this.fallbackWorkspace;
  }

  /**
   * Run request work inside one workspace (P1-13). Each active generation loads that workspace's settings first,
   * so `ctx.inject('settings')` (read synchronously) answers with them. Without a workspace (server mode) work
   * sees schema defaults and no secrets.
   */
  async runInWorkspace<T>(workspaceId: string | undefined, work: () => T | Promise<T>): Promise<T> {
    await this.ensureLegacyMigrated();
    if (workspaceId && workspaceId !== this.fallbackWorkspace) {
      for (const [id, generation] of this.active) {
        if (!this.options.deploymentSettings?.(id) && generation.settingsSchema && !generation.workspaceSettings.has(workspaceId)) {
          await this.generationSettings(id, generation, workspaceId);
        }
      }
    }
    return this.workspaceScope.run(workspaceId, work);
  }

  private settingsHome(id: string): string | undefined {
    return this.options.deploymentSettings?.(id) ? 'default' : this.fallbackWorkspace;
  }

  /** A generation's snapshot for the current workspace (synchronous; defaults when none is loaded). */
  private generationValues(generation: ExtensionGeneration): Record<string, unknown> {
    if (this.options.deploymentSettings?.(generation.id)) return generation.settings;
    const workspaceId = this.currentWorkspace();
    if (workspaceId && workspaceId === this.fallbackWorkspace) return generation.settings;
    return (workspaceId && generation.workspaceSettings.get(workspaceId)) || this.defaultSettings(generation.settingsSchema);
  }

  /** A generation's snapshot for one workspace, loaded on first use (a concurrent save's newer copy wins). */
  private async generationSettings(id: string, generation: ExtensionGeneration, workspaceId: string): Promise<Record<string, unknown>> {
    await this.ensureLegacyMigrated();
    if (this.options.deploymentSettings?.(id) || workspaceId === this.fallbackWorkspace) return generation.settings;
    const loaded = generation.workspaceSettings.get(workspaceId);
    if (loaded) return loaded;
    const values = (await this.readSettings(id, generation.settingsSchema, workspaceId)).values;
    if (!generation.workspaceSettings.has(workspaceId)) generation.workspaceSettings.set(workspaceId, values);
    return generation.workspaceSettings.get(workspaceId)!;
  }

  private defaultSettings(schema?: ExtensionSettingsSchema): Record<string, unknown> {
    const defaults: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(schema?.properties ?? {})) {
      if (prop.default !== undefined && !prop.secret) defaults[key] = prop.default;
    }
    return defaults;
  }

  private vaultService() {
    return this.services.vault as {
      get(scope: SettingsScope, name: string): Promise<string | undefined>;
      put(scope: SettingsScope, name: string, value: string): Promise<unknown>;
      delete?(scope: SettingsScope, name: string): Promise<boolean>;
    } | undefined;
  }

  /** Secret settings live in the vault, per workspace. */
  private secretScope(id: string, workspaceId: string): SettingsScope {
    return { kind: 'engine', workspaceId, subjectId: id };
  }

  private sanitize(values: Record<string, unknown>, schema?: ExtensionSettingsSchema): Record<string, unknown> {
    const sanitized = { ...values };
    for (const [key, property] of Object.entries(schema?.properties ?? {})) {
      if (property.secret) sanitized[key] = { set: typeof values[key] === 'string' && (values[key] as string).length > 0 };
    }
    return sanitized;
  }

  /** One extension's settings in a workspace (default: the current one), from the active generation's snapshot. */
  async getSettings(id: string, workspaceId = this.currentWorkspace()): Promise<{
    values: Record<string, unknown>;
    sanitized: Record<string, unknown>;
    schema?: ExtensionSettingsSchema;
  }> {
    await this.ensureLegacyMigrated();
    if (this.options.deploymentSettings?.(id)) workspaceId = this.settingsHome(id);
    const active = this.active.get(id);
    if (!active) return this.readSettings(id, this.discovered.get(id)?.manifest.settings, workspaceId);
    const schema = structuredClone(active.settingsSchema);
    const values = structuredClone(workspaceId ? await this.generationSettings(id, active, workspaceId)
      : this.defaultSettings(active.settingsSchema));
    return { values, sanitized: this.sanitize(values, schema), schema };
  }

  private async readSettings(id: string, schema: ExtensionSettingsSchema | undefined, workspaceId: string | undefined): Promise<{
    values: Record<string, unknown>; sanitized: Record<string, unknown>; schema?: ExtensionSettingsSchema;
  }> {
    const stored = workspaceId ? (await this.db.getWorkspaceSettings?.(id, workspaceId)) ?? {} : {};
    const values: Record<string, unknown> = { ...this.defaultSettings(schema), ...stored };
    const vault = this.vaultService();
    for (const [key, prop] of Object.entries(schema?.properties ?? {})) {
      if (!prop.secret) continue;
      let secret: string | undefined;
      if (workspaceId && vault) {
        try { secret = await vault.get(this.secretScope(id, workspaceId), secretNameForKey(key)); } catch {}
      }
      if (secret !== undefined && secret.length > 0) values[key] = secret; else delete values[key];
    }
    return { values, sanitized: this.sanitize(values, schema), schema: structuredClone(schema) };
  }

  saveSettings(id: string, incomingValues: Record<string, unknown>, workspaceId = this.currentWorkspace()): Promise<Record<string, unknown>> {
    // Serialize configuration with activation/upgrade so a health-gated candidate
    // cannot capture stale settings while a save mutates the serving generation.
    const input = structuredClone(incomingValues);
    const work = this.operation.then(() => this.writeSettings(id, input, workspaceId));
    this.operation = work.catch(() => {});
    return work;
  }

  /**
   * Validate values against the serving schema (wrong types such as the string "false" are refused with a
   * SettingsValidationError), store them for one workspace, and refresh only the active generation's snapshot:
   * a draining generation keeps the settings it started with. null clears a value; '' leaves a secret as is.
   */
  private async writeSettings(id: string, incomingValues: Record<string, unknown>, workspaceId: string | undefined): Promise<Record<string, unknown>> {
    if (this.options.deploymentSettings?.(id)) workspaceId = this.settingsHome(id);
    if (!workspaceId) throw new Error('Settings are saved for a workspace');
    await this.ensureLegacyMigrated();
    const active = this.active.get(id);
    const schema = active?.settingsSchema ?? this.discovered.get(id)?.manifest.settings;
    const accepted = coerceSettingValues(id, schema, incomingValues);
    const vault = this.vaultService();
    const stored: Record<string, unknown> = { ...((await this.db.getWorkspaceSettings?.(id, workspaceId)) ?? {}) };
    const secretWrites: [string, string | null][] = [];
    for (const [key, value] of Object.entries(accepted)) {
      if (schema?.properties?.[key]?.secret) {
        if (!vault) throw new Error('Secret settings need the vault');
        secretWrites.push([key, value as string | null]);
      } else if (value === null) delete stored[key];
      else stored[key] = value;
    }
    await this.db.setWorkspaceSettings?.(id, workspaceId, stored);
    for (const [key, value] of secretWrites) {
      const scope = this.secretScope(id, workspaceId);
      if (value === null) await vault!.delete?.(scope, secretNameForKey(key));
      else await vault!.put(scope, secretNameForKey(key), value);
    }
    const { values, sanitized } = await this.readSettings(id, schema, workspaceId);
    if (active) {
      const target = workspaceId === this.settingsHome(id) ? active.settings : active.workspaceSettings.get(workspaceId);
      if (target) {
        for (const key of Object.keys(target)) if (!(key in values)) delete target[key];
        Object.assign(target, values);
      } else active.workspaceSettings.set(workspaceId, values);
    }
    this.events.publishSettings(id, sanitized, workspaceId);
    return sanitized;
  }

  /**
   * Upgrade from before P1-13: settings stored without a workspace (the legacy table, and secrets in the vault's
   * 'default' scope) become the fallback workspace's (desktop: its one workspace). Values already stored per
   * workspace win; nothing is removed before it is copied.
   */
  /**
   * Move pre-P1-13 settings once a target workspace exists: at discover, or (server mode, when the first
   * workspace is created after start) on the first settings access after it appears.
   */
  private ensureLegacyMigrated(): Promise<void> {
    if (this.legacyMigrated) return Promise.resolve();
    this.legacyRun ??= (async () => {
      const target = this.fallbackWorkspace ?? await this.options.legacyWorkspace?.();
      if (!target) {
        if (!this.options.legacyWorkspace) this.legacyMigrated = true;
        return;
      }
      await this.migrateLegacySettings(target);
      // Snapshots of the target read before the move held defaults; they reload on next use.
      for (const generation of this.active.values()) generation.workspaceSettings.delete(target);
      for (const [id, generation] of this.active) {
        const home = this.settingsHome(id);
        if (home !== target && !this.options.deploymentSettings?.(id)) continue;
        const values = (await this.readSettings(id, generation.settingsSchema, home)).values;
        for (const key of Object.keys(generation.settings)) delete generation.settings[key];
        Object.assign(generation.settings, values);
      }
      this.legacyMigrated = true;
    })().finally(() => { this.legacyRun = undefined; });
    return this.legacyRun;
  }

  private async migrateLegacySettings(workspaceId: string): Promise<void> {
    for (const legacy of (await this.db.listLegacyExtensionSettings?.()) ?? []) {
      const target = this.options.deploymentSettings?.(legacy.id) ? 'default' : workspaceId;
      const current = await this.db.getWorkspaceSettings?.(legacy.id, target);
      await this.db.setWorkspaceSettings?.(legacy.id, target, { ...legacy.values, ...(current ?? {}) });
      await this.db.deleteLegacyExtensionSettings?.(legacy.id);
    }
    const vault = this.vaultService();
    if (!vault || workspaceId === 'default') return;
    for (const [id, { manifest }] of this.discovered) {
      if (this.options.deploymentSettings?.(id)) continue;
      for (const [key, prop] of Object.entries(manifest.settings?.properties ?? {})) {
        if (!prop.secret) continue;
        const name = secretNameForKey(key);
        const from = this.secretScope(id, 'default');
        const old = await vault.get(from, name);
        if (old === undefined) continue;
        const to = this.secretScope(id, workspaceId);
        if ((await vault.get(to, name)) === undefined) await vault.put(to, name, old);
        await vault.delete?.(from, name);
      }
    }
  }

  private async start(id: string, located = this.discovered.get(id)!, generation = new ExtensionGeneration(id), staged = false): Promise<ExtensionGeneration> {
    const { manifest, directory, managed } = located;
    const dataRoot = typeof this.services.extensionDataDir === 'string' ? this.services.extensionDataDir
      : managed && this.dataDir ? join(this.dataDir, 'extensions') : undefined;
    const dataDir = dataRoot && join(dataRoot, id);
    if (managed && dataDir) await mkdir(dataDir, { recursive: true });
    generation.settingsSchema = structuredClone(manifest.settings);
    // The fallback workspace's snapshot (server mode: none, so defaults only); other workspaces load per request.
    Object.assign(generation.settings, structuredClone((await this.readSettings(id, manifest.settings, this.settingsHome(id))).values));
    // `settings` keeps its plain-object shape for extensions but reads the current workspace's snapshot.
    const settingsView = new Proxy({} as Record<string, unknown>, {
      get: (_target, key) => typeof key === 'string' ? this.generationValues(generation)[key] : undefined,
      has: (_target, key) => typeof key === 'string' && key in this.generationValues(generation),
      ownKeys: () => Reflect.ownKeys(this.generationValues(generation)),
      getOwnPropertyDescriptor: (_target, key) => {
        const values = this.generationValues(generation);
        return typeof key === 'string' && key in values ? { value: values[key], enumerable: true, configurable: true, writable: false } : undefined;
      },
      set: () => false,
      deleteProperty: () => false,
    });
    // Background work names the workspace it serves.
    const settingsFor = (workspaceId: string) => this.generationSettings(id, generation, workspaceId).then((values) => structuredClone(values));
    generation.assertMutable();
    if (manifest.runtime.type === 'cordis') {
      const scope = new Context();
      generation.cleanup = () => scope.fiber.dispose();
      try {
        const entry = managed ? await managedCordisEntry(directory, manifest.runtime.entry) : resolve(directory, manifest.runtime.entry);
        generation.assertMutable();
        if (managed) pinCordisResolution(directory);
        const entryUrl = pathToFileURL(entry).href;
        const module = await import(entryUrl) as { default: NeoExtension };
        generation.assertMutable();
        if (typeof module.default?.activate !== 'function') throw new Error(`Missing activate() in ${id}`);
        let ctx!: ExtensionContext;
        await scope.plugin({
          name: `neo:${id}`,
          apply: (owner) => {
            generation.assertMutable();
            ctx = {
              signal: generation.abort.signal,
              provide: (name, value) => generation.provide(name, value),
              inject: <T>(name: string) => {
                if (name === 'settings') return settingsView as T;
                if (name === 'settingsFor') return settingsFor as T;
                if (managed && name === 'dataDir') return dataDir as T | undefined;
                if (generation.services.has(name)) return generation.services.get(name) as T;
                const provider = this.snapshot.serviceOwners.get(name);
                if (provider && provider !== id && !generation.injectedFrom.has(provider)) {
                  generation.injectedFrom.add(provider);
                  if (this.active.get(id) === generation) this.validatePendingPublication?.();
                }
                return (this.snapshot.services.get(name) ?? this.services[name]) as T | undefined;
              },
              effect: (register) => { generation.assertMutable(); owner.effect(register); },
              route: (path, handler) => { generation.assertMutable(); owner.effect(() => generation.route(path, handler)); },
              contribute: (kind, value) => { generation.assertMutable(); owner.effect(() => generation.contribute(kind, value)); },
              onDrain: (close) => generation.onDrain(close),
              health: (check) => { generation.assertMutable(); generation.check = async () => check(); },
            };
          },
        });
        // Cordis waits for plugin apply() during disposal. Activate outside
        // apply() so a stalled extension cannot prevent its effects being retired.
        generation.assertMutable();
        await module.default.activate(ctx);
      } catch (error) { await generation.dispose(0); throw error; }
      return generation;
    }
    if (manifest.runtime.type === 'process') {
      const { command, routeTimeoutMs } = manifest.runtime;
      const executable = managed ? await managedProcessCommand(directory, command, this.pythonExecutable) : command;
      generation.assertMutable();
      const runtime = new ExtensionProcess(executable, directory);
      generation.cleanup = () => runtime.stop();
      generation.check = () => runtime.health(generation.abort.signal);
      try {
        const registered = await runtime.initialize(id, dataDir
          ? { dataDir, projectionDir: join(dataDir, 'projections') } : {}, generation.abort.signal);
        for (const route of registered.routes) {
          if (typeof route.path !== 'string') throw new Error(`Invalid route from ${id}`);
          const timeoutMs = routeTimeoutMs && Object.hasOwn(routeTimeoutMs, route.path) ? routeTimeoutMs[route.path] : 30_000;
          generation.route(route.path, ({ method, body, signal }) => runtime.call('route.invoke', { path: route.path, method, body }, { timeoutMs, signal }));
        }
        for (const contribution of registered.contributions) {
          if (typeof contribution.id !== 'string' || typeof contribution.kind !== 'string') throw new Error(`Invalid contribution from ${id}`);
          generation.contribute(contribution.kind, contribution);
        }
        if (!staged) await generation.check();
      } catch (error) { await generation.dispose(0); throw error; }
    }
    return generation;
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.operation;
    await Promise.allSettled(this.retirements);
    for (const id of [...this.order].reverse()) {
      const generation = this.entries.get(id)?.running;
      if (generation) await this.retire(id, generation);
    }
    await this.db.close();
  }
}

type SettingsScope = { kind: 'engine'; workspaceId: string; subjectId: string };

export interface KernelOptions {
  /**
   * The workspace whose settings apply outside a request (P1-13). Default 'default' (single tenant, as before);
   * desktop passes its one workspace (legacy settings move into it); server mode passes null: work outside a
   * request sees schema defaults and no secrets.
   */
  fallbackWorkspace?: string | null;
  /**
   * Where pre-P1-13 workspace-less settings go when there is no fallback workspace (server mode). Resolved at each
   * discover; undefined leaves the legacy rows in place (nothing is lost) and a later start retries.
   */
  legacyWorkspace?: () => Promise<string | undefined>;
  /** Extensions whose settings use the deployment bucket in every request. */
  deploymentSettings?: (id: string) => boolean;
}

async function deadline<T>(operation: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
