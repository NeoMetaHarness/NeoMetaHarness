import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pandaSettingsSchema, type PandaSettings } from '@neometaharness/contracts';
import type { VaultService } from '@neometaharness/vault';
import { WorkspaceStorage, type ModelRole, type ModelRouter, type ModelSelection, type RoutedTask, type RouteAttempt,
  type EscalationLimits, type WorkspaceDirectory } from '../../models/src/hub.js';
import { DecisionLog } from '../../engine-superagent/src/decision-log.js';

/** PandaOrchestrator@83e408c794ef: serve/server.py:30-38 (/health, /route),
 * serve/router.py:73-86; schemas/route_request.schema.json:8-35 (task/pool),
 * schemas/route_response.schema.json:28-38 (choice.model_id). No engine imports. */
/** Settings are per workspace (P1-13): 'default' is the deployment's (desktop's only one); see WorkspaceStorage. */
export class PandaRouter implements ModelRouter {
  private readonly configs = new Map<string, PandaSettings | null>();
  private active = true;
  private readonly requests = new Set<AbortController>();
  private pending: Promise<unknown> = Promise.resolve();
  private readonly decisions: DecisionLog;
  private readonly storage: WorkspaceStorage;
  constructor(private readonly vault: VaultService, private readonly home: string, directory?: WorkspaceDirectory) {
    this.decisions = new DecisionLog(join(home, 'traces'));
    this.storage = new WorkspaceStorage(directory);
  }
  private file(key: string): string {
    return key === 'default' ? join(this.home, 'settings.json') : join(this.home, 'workspaces', key, 'settings.json');
  }
  private async read(key: string): Promise<PandaSettings | null> {
    try { return pandaSettingsSchema.parse(JSON.parse(await readFile(this.file(key), 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid Panda settings');
      return null;
    }
  }
  async load() { this.configs.set('default', await this.read('default')); }
  /** One workspace's settings; the bootstrap workspace starts from the deployment's (and its router secret). */
  private async configOf(workspace?: string): Promise<{ key: string; config: PandaSettings | null }> {
    const key = this.storage.key(workspace);
    if (this.configs.has(key)) return { key, config: this.configs.get(key)! };
    let config = await this.read(key);
    if (!config && await this.storage.inheritsDeployment(key)) {
      const deployment = this.configs.get('default') ?? null;
      if (deployment) {
        if (deployment.vaultSecret) {
          const secret = await this.vault.get(this.storage.scope('default'), deployment.vaultSecret);
          if (secret !== undefined && (await this.vault.get(this.storage.scope(key), deployment.vaultSecret)) === undefined) {
            await this.vault.put(this.storage.scope(key), deployment.vaultSecret, secret);
          }
        }
        config = structuredClone(deployment);
      }
    }
    if (!this.configs.has(key)) this.configs.set(key, config);
    return { key, config: this.configs.get(key)! };
  }
  async settings(workspace?: string): Promise<PandaSettings | null> {
    const { config } = await this.configOf(workspace);
    return config ? structuredClone(config) : null;
  }
  async escalationLimits(workspace?: string): Promise<EscalationLimits> {
    const { config } = await this.configOf(workspace);
    return this.active && config
      ? (config.escalation ?? { enabled: true, maxAttempts: 2, maxTotalMs: 30000 })
      : { enabled: false, maxAttempts: 1, maxTotalMs: 30000 };
  }
  async recordAttempt(entry: RouteAttempt): Promise<void> {
    if (!this.active) return;
    const { config } = await this.configOf(entry.task.workspace);
    const candidate = config?.roles[entry.tier]?.find((item) =>
      item.providerId === entry.selection.providerId && item.model === entry.selection.model);
    await this.decisions.record({ ...(entry.task.workspace ? { workspace: entry.task.workspace } : {}),
      ticketId: entry.task.ticketId ?? 'routed-turn', source: entry.task.source ?? 'neo/models',
      inputsSummary: entry.task.text.slice(0, 240),
      candidates: config?.roles[entry.tier]?.map((item) => item.modelId) ?? [],
      chosenAction: entry.attempt === 1 ? 'route' : 'escalate', modelRole: entry.role,
      model_id: candidate?.modelId ?? `${entry.selection.providerId}/${entry.selection.model}`,
      latencyMs: entry.latencyMs, outcome: entry.outcome, attempt: entry.attempt, tier: entry.tier,
    });
  }
  async configure(input: unknown, workspace?: string): Promise<PandaSettings> {
    const config = pandaSettingsSchema.parse(input);
    const key = this.storage.key(workspace);
    for (const candidates of Object.values(config.roles)) {
      if (new Set(candidates?.map((item) => item.modelId)).size !== candidates?.length) throw new Error('Duplicate Panda model ID');
    }
    const save = this.pending.then(async () => {
      if (!this.active) throw new Error('Panda extension is disabled');
      const file = this.file(key);
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(config), { mode: 0o600 });
      await rename(temp, file);
      this.abort();
      this.configs.set(key, config);
      return structuredClone(config);
    });
    this.pending = save.catch(() => {});
    return save;
  }
  private abort() { for (const request of this.requests) request.abort(); }
  async close() { this.active = false; this.abort(); await this.pending; }
  private async request(config: PandaSettings, storageKey: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.active) throw new Error('Panda extension is disabled');
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const key = config.vaultSecret
        ? await this.vault.get(this.storage.scope(storageKey), config.vaultSecret) : undefined;
      if (config.vaultSecret && !key) throw new Error('Missing router credential');
      const response = await fetch(`${config.endpoint.replace(/\/$/, '')}/${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Router unavailable'); }
      // Bound upstream data independently of Content-Length, including chunked responses.
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty router response');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 65536) { controller.abort(); throw new Error('Router response too large'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { clearTimeout(timer); this.requests.delete(controller); }
  }
  async health(workspace?: string): Promise<{ ok: boolean; configured: boolean }> {
    const { key, config } = await this.configOf(workspace);
    if (!config || !this.active) return { ok: false, configured: !!config };
    try {
      const status = await this.request(config, key, 'health') as { ok?: unknown } | null;
      return { ok: status?.ok === true && this.active && this.configs.get(key) === config, configured: true };
    } catch { return { ok: false, configured: true }; }
  }
  async select(role: ModelRole, _direct: ModelSelection, task?: RoutedTask): Promise<ModelSelection | undefined> {
    const { key, config } = await this.configOf(task?.workspace);
    const candidates = config?.roles[role];
    if (!this.active || !config || !candidates?.length) return undefined;
    try {
      const response = await this.request(config, key, 'route', {
        task: { text: task?.text.slice(0, 240) || `Select a model for Neo's ${role} role`, kind_hint: role },
        pool: candidates.map((candidate) => candidate.modelId),
      }) as { choice?: { model_id?: unknown } } | null;
      if (!this.active || this.configs.get(key) !== config) return undefined;
      const chosen = candidates.find((candidate) => candidate.modelId === response?.choice?.model_id);
      return chosen ? { providerId: chosen.providerId, model: chosen.model } : undefined;
    } catch { return undefined; } // Never return upstream error text (which could contain credentials).
  }
}
