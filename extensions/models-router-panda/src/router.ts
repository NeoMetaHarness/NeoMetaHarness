import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pandaSettingsSchema, type PandaSettings } from '@neometaharness/contracts';
import type { VaultService } from '@neometaharness/vault';
import type { ModelRole, ModelRouter, ModelSelection } from '../../models/src/hub.js';

/** PandaOrchestrator@83e408c794ef: serve/server.py:30-38 (/health, /route),
 * serve/router.py:73-86; schemas/route_request.schema.json:8-35 (task/pool),
 * schemas/route_response.schema.json:28-38 (choice.model_id). No engine imports. */
export class PandaRouter implements ModelRouter {
  private config: PandaSettings | null = null;
  private active = true;
  private readonly requests = new Set<AbortController>();
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly vault: VaultService, private readonly home: string) {}
  async load() {
    try { this.config = pandaSettingsSchema.parse(JSON.parse(await readFile(join(this.home, 'settings.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid Panda settings'); }
  }
  settings(): PandaSettings | null { return this.config ? structuredClone(this.config) : null; }
  async configure(input: unknown): Promise<PandaSettings> {
    const config = pandaSettingsSchema.parse(input);
    for (const candidates of Object.values(config.roles)) {
      if (new Set(candidates?.map((item) => item.modelId)).size !== candidates?.length) throw new Error('Duplicate Panda model ID');
    }
    const save = this.pending.then(async () => {
      if (!this.active) throw new Error('Panda extension is disabled');
      await mkdir(this.home, { recursive: true });
      const file = join(this.home, 'settings.json');
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(config), { mode: 0o600 });
      await rename(temp, file);
      this.abort();
      this.config = config;
      return structuredClone(config);
    });
    this.pending = save.catch(() => {});
    return save;
  }
  private abort() { for (const request of this.requests) request.abort(); }
  async close() { this.active = false; this.abort(); await this.pending; }
  private async request(config: PandaSettings, path: string, body?: unknown): Promise<unknown> {
    if (!this.active) throw new Error('Panda extension is disabled');
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const key = config.vaultSecret
        ? await this.vault.get({ kind: 'workspace', workspaceId: 'default' }, config.vaultSecret) : undefined;
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
  async health(): Promise<{ ok: boolean; configured: boolean }> {
    const config = this.config;
    if (!config || !this.active) return { ok: false, configured: !!config };
    try {
      const status = await this.request(config, 'health') as { ok?: unknown } | null;
      return { ok: status?.ok === true && this.active && this.config === config, configured: true };
    } catch { return { ok: false, configured: true }; }
  }
  async select(role: ModelRole, _direct: ModelSelection): Promise<ModelSelection | undefined> {
    const config = this.config;
    const candidates = config?.roles[role];
    if (!this.active || !config || !candidates?.length) return undefined;
    try {
      // Model Hub currently supplies role metadata, not prompt contents. Keep prompts and keys out of Panda.
      const response = await this.request(config, 'route', {
        task: { text: `Select a model for Neo's ${role} role`, kind_hint: role },
        pool: candidates.map((candidate) => candidate.modelId),
      }) as { choice?: { model_id?: unknown } } | null;
      if (!this.active || this.config !== config) return undefined;
      const chosen = candidates.find((candidate) => candidate.modelId === response?.choice?.model_id);
      return chosen ? { providerId: chosen.providerId, model: chosen.model } : undefined;
    } catch { return undefined; } // Never return upstream error text (which could contain credentials).
  }
}
