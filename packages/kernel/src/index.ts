import { ExtensionGeneration } from './generation.js';
import { Context } from '@deepseek-ai/cordis';
import semver from 'semver';
import { readdir, realpath } from 'node:fs/promises';
import { resolve, isAbsolute, relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseProvider } from '@neometaharness/db';
import type { ExtensionStatus, GatewayEvent } from '@neometaharness/contracts';
import type { ComputerNotice } from '@neometaharness/computers';
import { dependencyProblem, loadManifest, resolveOrder, type LocatedExtension, type ExtensionSettingsSchema } from './manifest.js';
import { ExtensionProcess } from './process.js';
export { ComputerMcpBridge, type ComputerMcpConfig, type ComputerMcpProjection } from './computer-mcp.js';
export { SkillsBridge, type SkillProjection } from './skills.js';

export { dependencyProblem, loadManifest, resolveOrder, validateSettings } from './manifest.js';
export type { ExtensionManifest, LocatedExtension, ExtensionSettingsSchema, SettingPropertySchema, SettingPropertyType } from './manifest.js';

export type RouteHandler = (input: { method: string; body?: unknown; signal?: AbortSignal }) => unknown | Promise<unknown>;
export type Health = { ok: boolean; pid?: number };

export interface ExtensionContext {
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

  publishSettings(extension: string, values: Record<string, unknown>): void {
    const event: GatewayEvent = { seq: ++this.nextSeq, extension, type: 'settings.change', values };
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
  private readonly entries = new Map<string, Entry>();
  private readonly active = new Map<string, ExtensionGeneration>();
  private snapshot = {
    routes: new Map<string, { generation: ExtensionGeneration; handler: RouteHandler }>(),
    contributions: new Map<string, { id: string; [key: string]: unknown }>(),
    services: new Map<string, unknown>(),
  };
  private operation: Promise<unknown> = Promise.resolve();
  private order: string[] = [];

  constructor(private readonly db: DatabaseProvider, private readonly services: Readonly<Record<string, unknown>> = {}) {}

  async discover(root: string): Promise<void> {
    for (const dirent of await readdir(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const directory = resolve(root, dirent.name);
      try {
        const manifest = await loadManifest(directory);
        if (this.discovered.has(manifest.id)) throw new Error(`Duplicate extension id: ${manifest.id}`);
        this.discovered.set(manifest.id, { manifest, directory });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await this.db.migrate();
    for (const [id] of this.discovered) {
      const installed = await this.db.getExtensionInstall?.(id);
      if (!installed) continue;
      const directory = await realpath(installed.directory);
      const manifest = await loadManifest(directory);
      if (manifest.id !== id || manifest.version !== installed.version) throw new Error(`Installed extension identity changed: ${id}`);
      this.discovered.set(id, { manifest, directory });
    }
    this.order = resolveOrder(this.discovered);
    for (const id of this.order) {
      this.entries.set(id, { desired: await this.db.getEnabled(id), status: 'disabled' });
    }
    await this.reconcile();
  }

  list(): ExtensionStatus[] {
    return this.order.map((id) => this.status(id));
  }

  status(id: string): ExtensionStatus {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown extension: ${id}`);
    const manifest = this.discovered.get(id)?.manifest;
    return {
      id, version: manifest!.version,
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

  /** Stage and health-check a local immutable version; old registrations remain live until commit. */
  upgrade(id: string, directory: string, options: { healthTimeoutMs?: number; drainTimeoutMs?: number } = {}): Promise<{
    extension: ExtensionStatus; previousVersion: string; upgraded: boolean; reason?: string;
  }> {
    const work = this.operation.then(async () => {
      const entry = this.entries.get(id);
      const previous = this.discovered.get(id);
      if (!entry || !previous) throw new Error(`Unknown extension: ${id}`);
      const old = entry.running;
      let candidate: ExtensionGeneration | undefined;
      let persisted = false;
      try {
        if (!old || !entry.desired) throw new Error('Enable the extension before upgrading');
        if (!this.db.setExtensionInstall) throw new Error('Database provider does not support installed extension versions');
        if (!isAbsolute(directory)) throw new Error('Upgrade directory must be absolute');
        directory = await realpath(directory);
        if (directory === await realpath(previous.directory)) throw new Error('Upgrade requires a separate immutable version directory');
        const manifest = await loadManifest(directory);
        if (manifest.id !== id || !semver.gt(manifest.version, previous.manifest.version)) throw new Error('Upgrade requires the same id and a newer version');
        if (manifest.runtime.type === 'cordis') {
          const path = relative(directory, await realpath(resolve(directory, manifest.runtime.entry)));
          if (path.startsWith('..') || isAbsolute(path)) throw new Error('Extension entry escapes install root');
        }
        const located = { manifest, directory };
        const prospective = new Map(this.discovered).set(id, located);
        const order = resolveOrder(prospective);
        for (const value of prospective.values()) {
          const problem = dependencyProblem(value.manifest, prospective);
          if (problem && (value.manifest.id === id || this.entries.get(value.manifest.id)?.desired)) throw new Error(problem);
        }
        for (const dependency of Object.keys(manifest.dependsOn ?? {})) {
          if (this.entries.get(dependency)?.status !== 'running') throw new Error(`Dependency ${dependency} is not running`);
        }
        candidate = new ExtensionGeneration(id);
        await deadline(this.start(id, located, candidate), options.healthTimeoutMs ?? 5000, 'Extension activation timed out');
        const health = await deadline(candidate.check(), options.healthTimeoutMs ?? 5000, 'Extension health check timed out');
        if (health.ok !== true) throw new Error('Candidate extension is unhealthy');
        this.compile(new Map(this.active).set(id, candidate));
        await this.db.setExtensionInstall(id, { directory, version: manifest.version });
        persisted = true;
        this.publish(id, candidate);
        this.discovered.set(id, located); this.order = order; entry.running = candidate;
      } catch (error) {
        if (persisted) await this.db.setExtensionInstall!(id, { directory: previous.directory, version: previous.manifest.version });
        if (candidate) await candidate.dispose(0);
        return { extension: this.status(id), previousVersion: previous.manifest.version, upgraded: false, reason: (error as Error).message };
      }
      // Commit is final. A teardown failure must never switch back to a partially retired generation.
      try { await old!.dispose(options.drainTimeoutMs ?? 5000); }
      catch { return { extension: this.status(id), previousVersion: previous.manifest.version, upgraded: true, reason: 'Upgrade committed; old generation cleanup failed' }; }
      return { extension: this.status(id), previousVersion: previous.manifest.version, upgraded: true };
    });
    this.operation = work.catch(() => {}); return work;
  }

  private setEnabled(id: string, enabled: boolean): Promise<ExtensionStatus> {
    const work = this.operation.then(async () => {
      const entry = this.entries.get(id);
      if (!entry) throw new Error(`Unknown extension: ${id}`);
      await this.db.setEnabled(id, enabled);
      entry.desired = enabled;
      await this.reconcile();
      return this.status(id);
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
      eligible.set(id, entry.desired && !problem);
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
        this.setStatus(id, 'disabled');
        continue;
      }
      const runtimeProblem = problems.get(id)
        ?? Object.keys(this.discovered.get(id)!.manifest.dependsOn ?? {})
          .filter((dependency) => this.entries.get(dependency)?.status !== 'running')
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
      this.setStatus(id, 'running');
    }
  }

  private compile(active: ReadonlyMap<string, ExtensionGeneration>) {
    const routes = new Map<string, { generation: ExtensionGeneration; handler: RouteHandler }>();
    const contributions = new Map<string, { id: string; [key: string]: unknown }>();
    const services = new Map<string, unknown>();
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
      }
    }
    return { routes, contributions, services };
  }

  private publish(id: string, generation: ExtensionGeneration) {
    const next = new Map(this.active).set(id, generation);
    const snapshot = this.compile(next);
    this.active.set(id, generation);
    this.snapshot = snapshot; // One synchronous pointer swap publishes all registrations.
    generation.changed = () => {
      if (this.active.get(id) === generation) this.snapshot = this.compile(this.active);
    };
  }

  private async retire(id: string, generation: ExtensionGeneration) {
    if (this.active.get(id) === generation) {
      this.active.delete(id); this.snapshot = this.compile(this.active);
    }
    await generation.dispose();
  }

  contributionIds(): string[] { return [...this.snapshot.contributions.keys()]; }
  async invokeRoute(path: string, method: string, body?: unknown): Promise<unknown | undefined> {
    const route = this.snapshot.routes.get(path);
    return route?.generation.invoke(route.handler, method, body);
  }
  hasRoute(path: string): boolean { return this.snapshot.routes.has(path); }
  routesFor(id: string): string[] { return [...this.snapshot.routes.keys()].filter((route) => route.startsWith(`/x/${id}/`)); }

  hasExtension(id: string): boolean {
    return this.discovered.has(id);
  }

  getSettingsSchema(id: string): ExtensionSettingsSchema | undefined {
    return this.discovered.get(id)?.manifest.settings;
  }

  async getSettings(id: string): Promise<{
    values: Record<string, unknown>;
    sanitized: Record<string, unknown>;
    schema?: ExtensionSettingsSchema;
  }> {
    return this.readSettings(id, this.discovered.get(id)?.manifest.settings);
  }

  private async readSettings(id: string, schema?: ExtensionSettingsSchema): Promise<{
    values: Record<string, unknown>; sanitized: Record<string, unknown>; schema?: ExtensionSettingsSchema;
  }> {
    const defaults: Record<string, unknown> = {};
    if (schema?.properties) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        if (prop.default !== undefined) {
          defaults[key] = prop.default;
        }
      }
    }
    const dbValues = (await this.db.getExtensionSettings?.(id)) ?? {};
    const values: Record<string, unknown> = { ...defaults, ...dbValues };
    const sanitized: Record<string, unknown> = { ...defaults, ...dbValues };

    const vault = this.services.vault as {
      get(scope: { kind: string; workspaceId: string; subjectId?: string }, name: string): Promise<string | undefined>;
    } | undefined;

    if (schema?.properties && vault) {
      const scope = { kind: 'engine', workspaceId: 'default', subjectId: id };
      for (const [key, prop] of Object.entries(schema.properties)) {
        if (prop.secret) {
          const secretName = secretNameForKey(key);
          let secretVal: string | undefined;
          try {
            secretVal = await vault.get(scope, secretName);
          } catch {}
          const hasSecret = secretVal !== undefined && secretVal.length > 0;
          if (hasSecret) {
            values[key] = secretVal;
          } else {
            delete values[key];
          }
          sanitized[key] = { set: hasSecret };
        }
      }
    }

    return { values, sanitized, schema };
  }

  async saveSettings(id: string, incomingValues: Record<string, unknown>): Promise<Record<string, unknown>> {
    const discovered = this.discovered.get(id);
    const schema = discovered?.manifest.settings;
    const vault = this.services.vault as {
      get(scope: { kind: string; workspaceId: string; subjectId?: string }, name: string): Promise<string | undefined>;
      put(scope: { kind: string; workspaceId: string; subjectId?: string }, name: string, value: string): Promise<unknown>;
    } | undefined;
    const scope = { kind: 'engine', workspaceId: 'default', subjectId: id };

    const currentDb = (await this.db.getExtensionSettings?.(id)) ?? {};
    const updatedDb: Record<string, unknown> = { ...currentDb };
    const secretUpdates: Record<string, string> = {};

    for (const [key, val] of Object.entries(incomingValues)) {
      const isSecret = Boolean(schema?.properties?.[key]?.secret);
      if (isSecret && vault) {
        if (typeof val === 'string' && val.length > 0) {
          secretUpdates[key] = val;
        }
      } else if (!isSecret) {
        updatedDb[key] = val;
      }
    }

    if (this.db.setExtensionSettings) {
      await this.db.setExtensionSettings(id, updatedDb);
    }

    for (const [key, secretVal] of Object.entries(secretUpdates)) {
      const secretName = secretNameForKey(key);
      await vault!.put(scope, secretName, secretVal);
    }

    const { values, sanitized } = await this.getSettings(id);

    const runningSettings = this.active.get(id)?.settings;
    if (runningSettings) {
      for (const key of Object.keys(runningSettings)) {
        if (!(key in values)) delete runningSettings[key];
      }
      Object.assign(runningSettings, values);
    }

    this.events.publishSettings(id, sanitized);
    return sanitized;
  }

  private async start(id: string, located = this.discovered.get(id)!, generation = new ExtensionGeneration(id)): Promise<ExtensionGeneration> {
    const { manifest, directory } = located;
    generation.settingsSchema = structuredClone(manifest.settings);
    Object.assign(generation.settings, structuredClone((await this.readSettings(id, manifest.settings)).values));
    if (manifest.runtime.type === 'cordis') {
      const scope = new Context();
      generation.cleanup = () => scope.fiber.dispose();
      try {
        const entryUrl = pathToFileURL(resolve(directory, manifest.runtime.entry)).href;
        const module = await import(entryUrl) as { default: NeoExtension };
        if (typeof module.default?.activate !== 'function') throw new Error(`Missing activate() in ${id}`);
        await scope.plugin({
          name: `neo:${id}`,
          apply: async (owner) => {
            const ctx: ExtensionContext = {
              provide: (name, value) => generation.provide(name, value),
              inject: <T>(name: string) => (name === 'settings' ? generation.settings : generation.services.get(name) ?? this.snapshot.services.get(name) ?? this.services[name]) as T | undefined,
              effect: (register) => { owner.effect(register); },
              route: (path, handler) => { owner.effect(() => generation.route(path, handler)); },
              contribute: (kind, value) => { owner.effect(() => generation.contribute(kind, value)); },
              onDrain: (close) => generation.onDrain(close),
              health: (check) => { generation.check = async () => check(); },
            };
            await module.default.activate(ctx);
          },
        });
      } catch (error) { await generation.dispose(0); throw error; }
      return generation;
    }
    if (manifest.runtime.type === 'process') {
      const runtime = new ExtensionProcess(manifest.runtime.command, directory);
      generation.cleanup = () => runtime.stop();
      generation.check = () => runtime.health();
      try {
        const registered = await runtime.initialize(id, typeof this.services.extensionDataDir === 'string'
          ? { dataDir: join(this.services.extensionDataDir, id), projectionDir: join(this.services.extensionDataDir, id, 'projections') } : {});
        for (const route of registered.routes) {
          if (typeof route.path !== 'string') throw new Error(`Invalid route from ${id}`);
          generation.route(route.path, ({ method, body }) => runtime.call('route.invoke', { path: route.path, method, body }));
        }
        for (const contribution of registered.contributions) {
          if (typeof contribution.id !== 'string' || typeof contribution.kind !== 'string') throw new Error(`Invalid contribution from ${id}`);
          generation.contribute(contribution.kind, contribution);
        }
        await runtime.health();
      } catch (error) { await generation.dispose(0); throw error; }
    }
    return generation;
  }

  async close(): Promise<void> {
    await this.operation;
    for (const id of [...this.order].reverse()) {
      const generation = this.entries.get(id)?.running;
      if (generation) await this.retire(id, generation);
    }
    await this.db.close();
  }
}

async function deadline<T>(operation: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
