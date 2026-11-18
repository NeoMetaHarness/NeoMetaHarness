import { Context } from '@deepseek-ai/cordis';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
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

export type RouteHandler = (input: { method: string; body?: unknown }) => unknown | Promise<unknown>;
export type Health = { ok: boolean; pid?: number };

export interface ExtensionContext {
  provide(name: string, value: unknown): void;
  inject<T = unknown>(name: string): T | undefined;
  effect(register: () => () => void | Promise<void>): void;
  route(path: string, handler: RouteHandler): void;
  contribute(kind: string, value: { id: string; [key: string]: unknown }): void;
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

interface RunningExtension {
  dispose(): Promise<void>;
  health(): Promise<Health>;
}

interface Entry {
  desired: boolean;
  status: ExtensionStatus['status'];
  reason?: string;
  running?: RunningExtension;
}

/** A small Cordis facade. Each Cordis activation owns its routes, contributions and services. */
export class NeoKernel {
  readonly events = new GatewayEvents();
  private readonly cordis = new Context();
  private readonly discovered = new Map<string, LocatedExtension>();
  private readonly entries = new Map<string, Entry>();
  private readonly routes = new Map<string, RouteHandler>();
  private readonly contributions = new Map<string, { id: string; [key: string]: unknown }>();
  private readonly activeSettings = new Map<string, Record<string, unknown>>();
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
    this.order = resolveOrder(this.discovered);
    await this.db.migrate();
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
      id,
      desired: entry.desired,
      status: entry.status,
      ...(entry.reason ? { reason: entry.reason } : {}),
      routes: this.routesFor(id),
      ...(manifest?.settings ? { settings: manifest.settings as any } : {}),
    };
  }

  async health(id: string): Promise<Health | undefined> {
    return this.entries.get(id)?.running?.health();
  }

  enable(id: string): Promise<ExtensionStatus> { return this.setEnabled(id, true); }
  disable(id: string): Promise<ExtensionStatus> { return this.setEnabled(id, false); }

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
        await entry.running.dispose();
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
          await entry.running.dispose();
          entry.running = undefined;
        }
        this.setStatus(id, 'degraded', runtimeProblem);
        continue;
      }
      if (!entry.running) {
        try {
          entry.running = await this.start(id);
        } catch (error) {
          this.setStatus(id, 'degraded', (error as Error).message);
          continue;
        }
      }
      this.setStatus(id, 'running');
    }
  }

  private addRoute(id: string, path: string, handler: RouteHandler): () => void {
    if (!/^[a-z][a-z0-9/-]*$/.test(path) || path.includes('//') || path.includes('..')) throw new Error(`Invalid route ${path}`);
    const route = `/x/${id}/${path}`;
    if (this.routes.has(route)) throw new Error(`Duplicate route ${route}`);
    this.routes.set(route, handler);
    return () => { this.routes.delete(route); };
  }

  private addContribution(id: string, kind: string, value: { id: string; [key: string]: unknown }): () => void {
    const key = `${kind}:${value.id}`;
    if (this.contributions.has(key)) throw new Error(`Duplicate contribution ${key}`);
    this.contributions.set(key, value);
    return () => { this.contributions.delete(key); };
  }

  contributionIds(): string[] { return [...this.contributions.keys()]; }

  async invokeRoute(path: string, method: string, body?: unknown): Promise<unknown | undefined> {
    const handler = this.routes.get(path);
    return handler?.({ method, body });
  }

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
    const discovered = this.discovered.get(id);
    const schema = discovered?.manifest.settings;
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

    const runningSettings = this.activeSettings.get(id);
    if (runningSettings) {
      for (const key of Object.keys(runningSettings)) {
        if (!(key in values)) delete runningSettings[key];
      }
      Object.assign(runningSettings, values);
    }

    this.events.publishSettings(id, sanitized);
    return sanitized;
  }

  hasRoute(path: string): boolean { return this.routes.has(path); }

  routesFor(id: string): string[] {
    const prefix = `/x/${id}/`;
    return [...this.routes.keys()].filter((route) => route.startsWith(prefix));
  }

  private async start(id: string): Promise<RunningExtension> {
    const { manifest, directory } = this.discovered.get(id)!;
    if (manifest.runtime.type === 'cordis') {
      const entryUrl = pathToFileURL(resolve(directory, manifest.runtime.entry)).href;
      const module = await import(entryUrl) as { default: NeoExtension };
      if (typeof module.default?.activate !== 'function') throw new Error(`Missing activate() in ${id}`);
      const { values: initialSettings } = await this.getSettings(id);
      const settingsObj = { ...initialSettings };
      this.activeSettings.set(id, settingsObj);
      let check: () => Health | Promise<Health> = () => ({ ok: true });
      const fiber = await this.cordis.plugin({
        name: `neo:${id}`,
        apply: async (cordisContext) => {
          const ctx: ExtensionContext = {
            provide: (name, value) => { cordisContext.provide(name, value); },
            inject: <T>(name: string) => {
              if (name === 'settings') {
                return settingsObj as T;
              }
              return (cordisContext.reflect.get(name) ?? this.services[name]) as T | undefined;
            },
            effect: (register) => { cordisContext.effect(register); },
            route: (path, handler) => { cordisContext.effect(() => this.addRoute(id, path, handler)); },
            contribute: (kind, value) => { cordisContext.effect(() => this.addContribution(id, kind, value)); },
            health: (handler) => { check = handler; },
          };
          await module.default.activate(ctx);
        },
      });
      return {
        dispose: async () => {
          this.activeSettings.delete(id);
          await fiber.dispose();
        },
        health: async () => check(),
      };
    }
    if (manifest.runtime.type === 'process') {
      const runtime = new ExtensionProcess(manifest.runtime.command, directory);
      const cleanups: (() => void)[] = [];
      try {
        const registered = await runtime.initialize(id);
        for (const route of registered.routes) {
          if (typeof route.path !== 'string') throw new Error(`Invalid route from ${id}`);
          cleanups.push(this.addRoute(id, route.path, ({ method, body }) => runtime.call('route.invoke', { path: route.path, method, body })));
        }
        for (const contribution of registered.contributions) {
          if (typeof contribution.id !== 'string' || typeof contribution.kind !== 'string') throw new Error(`Invalid contribution from ${id}`);
          cleanups.push(this.addContribution(id, contribution.kind, contribution));
        }
        await runtime.health();
        return {
          dispose: async () => { for (const cleanup of cleanups.reverse()) cleanup(); await runtime.stop(); },
          health: () => runtime.health(),
        };
      } catch (error) {
        for (const cleanup of cleanups.reverse()) cleanup();
        await runtime.stop();
        throw error;
      }
    }
    return { dispose: async () => {}, health: async () => ({ ok: true }) };
  }

  async close(): Promise<void> {
    await this.operation;
    for (const id of [...this.order].reverse()) await this.entries.get(id)?.running?.dispose();
    await this.cordis.fiber.dispose();
    await this.db.close();
  }
}
