import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { restrictPrivatePath, type VaultService } from '@neometaharness/vault';
import type { AppsRegistry } from '@neometaharness/kernel';
import type { McpConfig, McpProjection } from '@neometaharness/kernel';
import type { McpEngine } from '@neometaharness/kernel';
import { appsOperationSchema } from '@neometaharness/contracts';
type Consumer = { engine: McpEngine; profile: string; home: string; workspace: string; token: string; file: string; config: McpConfig };
export class AppsProjection implements McpProjection {
  private active = true;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly consumers = new Map<string, Consumer>();
  constructor(private readonly vault: VaultService, private readonly apps: AppsRegistry, private readonly gateway: () => string) {}
  private key(engine: McpEngine, profile: string) { return JSON.stringify([engine, profile]); }
  private scope(value: { engine: McpEngine; profile: string; workspace: string }) {
    return { kind: 'engine' as const, workspaceId: value.workspace, subjectId: `engine-${value.engine}/${value.profile}` };
  }
  ready(engine: McpEngine, profile: string, home: string, workspace: string): Promise<McpConfig> {
    const work = this.pending.then(async () => {
      if (!this.active) throw new Error('Apps MCP projection disabled');
      if (!workspace || workspace === 'default' || !profile) throw new Error('Explicit Apps MCP workspace required');
      const key = this.key(engine, profile);
      const previous = this.consumers.get(key);
      if (previous && (previous.home !== home || previous.workspace !== workspace)) throw new Error('Apps MCP profile scope changed');
      if (previous) return previous.config;
      const file = join(home, 'neo-apps-mcp', 'binding.json');
      const token = randomBytes(32).toString('hex');
      const config: McpConfig = { transport: 'stdio', serverName: 'neo_apps', command: process.execPath,
        args: [fileURLToPath(new URL('./mcp-server.mjs', import.meta.url))], env: { NEO_APPS_MCP_BINDING: file } };
      const consumer = { engine, profile, home, workspace, token, file, config };
      this.consumers.set(key, consumer);
      try {
        await this.vault.put(this.scope(consumer), 'NEO_APPS_MCP_TOKEN', token);
        await mkdir(join(home, 'neo-apps-mcp'), { recursive: true });
        const temp = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, JSON.stringify({ endpoint: `${this.gateway()}/internal/apps-mcp/action`, engine, profile, workspace, token }), { mode: 0o600 });
          await restrictPrivatePath(temp); await rename(temp, file);
        } finally { await rm(temp, { force: true }); }
        if (engine === 'hermes') await this.hermes(consumer, true);
        return config;
      } catch (error) { await this.remove(consumer); this.consumers.delete(key); throw error; }
    });
    this.pending = work.catch(() => {}); return work;
  }
  private async hermes(consumer: Consumer, enabled: boolean) {
    const file = join(consumer.home, 'config.yaml');
    const original = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return '{}'; throw error; });
    const document = YAML.parseDocument(original); if (document.errors.length) throw new Error('Invalid Hermes MCP configuration');
    const existing = document.getIn(['mcp_servers', 'neo_apps']);
    if (enabled) {
      if (existing && document.getIn(['mcp_servers', 'neo_apps', 'env', 'NEO_APPS_MCP_BINDING']) !== consumer.file) throw new Error('Hermes MCP server name is already configured');
      document.setIn(['mcp_servers', 'neo_apps'], { command: consumer.config.command, args: consumer.config.args, env: consumer.config.env });
      const configured = document.getIn(['platform_toolsets', 'api_server']);
      const names = YAML.isSeq(configured) ? configured.toJSON() as string[] : ['hermes-api-server'];
      if (!names.includes('mcp-neo_apps')) document.setIn(['platform_toolsets', 'api_server'], [...names, 'mcp-neo_apps']);
    } else {
      if (document.getIn(['mcp_servers', 'neo_apps', 'env', 'NEO_APPS_MCP_BINDING']) !== consumer.file) return;
      document.deleteIn(['mcp_servers', 'neo_apps']);
      const configured = document.getIn(['platform_toolsets', 'api_server']);
      if (YAML.isSeq(configured)) document.setIn(['platform_toolsets', 'api_server'], (configured.toJSON() as string[]).filter((name) => name !== 'mcp-neo_apps'));
    }
    const temp = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temp, String(document), { mode: 0o600 }); await rename(temp, file); }
    finally { await rm(temp, { force: true }); }
  }
  private async remove(consumer: Consumer) {
    await rm(consumer.file, { force: true });
    await this.vault.delete(this.scope(consumer), 'NEO_APPS_MCP_TOKEN');
    if (consumer.engine === 'hermes') await this.hermes(consumer, false);
  }
  async forget(engine: McpEngine, profile: string) {
    await this.pending;
    const key = this.key(engine, profile); const consumer = this.consumers.get(key);
    this.consumers.delete(key); if (consumer) await this.remove(consumer);
  }
  async removeAll() {
    this.active = false; await this.pending;
    const consumers = [...this.consumers.values()]; this.consumers.clear();
    const results = await Promise.allSettled(consumers.map((consumer) => this.remove(consumer)));
    if (results.some((result) => result.status === 'rejected')) throw new Error('Apps MCP projection cleanup failed');
  }
  async action(input: { authorization?: string; payload?: unknown }): Promise<{ status: number; body: unknown }> {
    const denied = { status: 403, body: { error: 'Apps MCP capability denied' } };
    if (!this.active || !input.payload || typeof input.payload !== 'object') return denied;
    const payload = input.payload as { engine?: unknown; profile?: unknown; workspace?: unknown; action?: unknown };
    const match = /^Bearer ([a-f0-9]{64})$/.exec(input.authorization ?? '');
    if (!match || typeof payload.engine !== 'string' || typeof payload.profile !== 'string') return denied;
    const consumer = this.consumers.get(this.key(payload.engine as McpEngine, payload.profile));
    if (!consumer || payload.workspace !== consumer.workspace || !timingSafeEqual(Buffer.from(match[1]!, 'hex'), Buffer.from(consumer.token, 'hex'))) return denied;
    const expected = await this.vault.get(this.scope(consumer), 'NEO_APPS_MCP_TOKEN');
    if (!expected || !/^[a-f0-9]{64}$/.test(expected) || !timingSafeEqual(Buffer.from(match[1]!, 'hex'), Buffer.from(expected, 'hex'))) return denied;
    const action = appsOperationSchema.safeParse(payload.action);
    if (!action.success) return { status: 400, body: { error: 'Invalid apps operation' } };
    try {
      const args = action.data;
      if (args.operation === 'connect') throw new Error('Connect accounts through the authenticated App, then grant this profile access');
      const body = args.operation === 'toolkits' ? await this.apps.toolkits(args.provider)
        : await this.apps.run(args, { kind: 'engine', engine: consumer.engine, profile: consumer.profile, workspaceId: consumer.workspace });
      return { status: 200, body };
    } catch { return { status: 403, body: { error: 'Apps operation unavailable or awaiting a valid policy service' } }; }
  }
}
