import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { restrictPrivatePath, type VaultService } from '@neometaharness/vault';
import type { ComputerRegistry } from '@neometaharness/computers';
import type { ComputerMcpConfig, ComputerMcpProjection } from '@neometaharness/kernel';
import type { ComputerEngine } from '../../../packages/kernel/src/computer-mcp.js';
import { computerActionSchema } from '@neometaharness/contracts';
type Consumer = { engine: ComputerEngine; profile: string; home: string; workspace: string; token: string; file: string; config: ComputerMcpConfig };
export class ComputerProjection implements ComputerMcpProjection {
  private active = true;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly consumers = new Map<string, Consumer>();
  constructor(private readonly vault: VaultService, private readonly computers: ComputerRegistry, private readonly gateway: () => string) {}
  private key(engine: ComputerEngine, profile: string) { return JSON.stringify([engine, profile]); }
  private scope(value: { engine: ComputerEngine; profile: string; workspace: string }) {
    return { kind: 'engine' as const, workspaceId: value.workspace, subjectId: `engine-${value.engine}/${value.profile}` };
  }
  ready(engine: ComputerEngine, profile: string, home: string, workspace: string): Promise<ComputerMcpConfig> {
    const work = this.pending.then(async () => {
      if (!this.active) throw new Error('Computer MCP projection disabled');
      const key = this.key(engine, profile);
      const previous = this.consumers.get(key);
      if (previous && (previous.home !== home || previous.workspace !== workspace)) throw new Error('Computer MCP profile scope changed');
      if (previous) return previous.config;
      const file = join(home, 'neo-computers-mcp', 'binding.json');
      const token = randomBytes(32).toString('hex');
      const config: ComputerMcpConfig = { transport: 'stdio', serverName: 'neo_computers', command: process.execPath,
        args: [fileURLToPath(new URL('./mcp-server.mjs', import.meta.url))], env: { NEO_COMPUTER_MCP_BINDING: file } };
      const consumer = { engine, profile, home, workspace, token, file, config };
      this.consumers.set(key, consumer);
      try {
        await this.vault.put(this.scope(consumer), 'NEO_COMPUTER_MCP_TOKEN', token);
        await mkdir(join(home, 'neo-computers-mcp'), { recursive: true });
        const temp = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, JSON.stringify({ endpoint: `${this.gateway()}/internal/computers-mcp/action`, engine, profile, token }), { mode: 0o600 });
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
    const existing = document.getIn(['mcp_servers', 'neo_computers']);
    if (enabled) {
      if (existing && document.getIn(['mcp_servers', 'neo_computers', 'env', 'NEO_COMPUTER_MCP_BINDING']) !== consumer.file) throw new Error('Hermes MCP server name is already configured');
      document.setIn(['mcp_servers', 'neo_computers'], { command: consumer.config.command, args: consumer.config.args, env: consumer.config.env });
      const configured = document.getIn(['platform_toolsets', 'api_server']);
      const names = YAML.isSeq(configured) ? configured.toJSON() as string[] : ['hermes-api-server'];
      if (!names.includes('mcp-neo_computers')) document.setIn(['platform_toolsets', 'api_server'], [...names, 'mcp-neo_computers']);
    } else {
      if (document.getIn(['mcp_servers', 'neo_computers', 'env', 'NEO_COMPUTER_MCP_BINDING']) !== consumer.file) return;
      document.deleteIn(['mcp_servers', 'neo_computers']);
      const configured = document.getIn(['platform_toolsets', 'api_server']);
      if (YAML.isSeq(configured)) document.setIn(['platform_toolsets', 'api_server'], (configured.toJSON() as string[]).filter((name) => name !== 'mcp-neo_computers'));
    }
    const temp = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temp, String(document), { mode: 0o600 }); await rename(temp, file); }
    finally { await rm(temp, { force: true }); }
  }
  private async remove(consumer: Consumer) {
    await rm(consumer.file, { force: true });
    await this.vault.delete(this.scope(consumer), 'NEO_COMPUTER_MCP_TOKEN');
    if (consumer.engine === 'hermes') await this.hermes(consumer, false);
  }
  async forget(engine: ComputerEngine, profile: string) {
    await this.pending;
    const key = this.key(engine, profile); const consumer = this.consumers.get(key);
    this.consumers.delete(key); if (consumer) await this.remove(consumer);
  }
  async removeAll() {
    this.active = false; await this.pending;
    const consumers = [...this.consumers.values()]; this.consumers.clear();
    const results = await Promise.allSettled(consumers.map((consumer) => this.remove(consumer)));
    if (results.some((result) => result.status === 'rejected')) throw new Error('Computer MCP projection cleanup failed');
  }
  async action(input: { authorization?: string; payload?: unknown }): Promise<{ status: number; body: unknown }> {
    const denied = { status: 403, body: { error: 'Computer MCP capability denied' } };
    if (!this.active || !input.payload || typeof input.payload !== 'object') return denied;
    const payload = input.payload as { engine?: unknown; profile?: unknown; action?: unknown };
    const match = /^Bearer ([a-f0-9]{64})$/.exec(input.authorization ?? '');
    if (!match || typeof payload.engine !== 'string' || typeof payload.profile !== 'string') return denied;
    const consumer = this.consumers.get(this.key(payload.engine as ComputerEngine, payload.profile));
    if (!consumer || !timingSafeEqual(Buffer.from(match[1]!, 'hex'), Buffer.from(consumer.token, 'hex'))) return denied;
    const action = computerActionSchema.safeParse(payload.action);
    if (!action.success) return { status: 400, body: { error: 'Invalid computer action' } };
    const binding = this.computers.binding(consumer.engine, consumer.profile);
    if (!binding) return denied;
    try { return { status: 200, body: await this.computers.act(binding.token, action.data, () => this.active && this.consumers.get(this.key(consumer.engine, consumer.profile)) === consumer) }; }
    catch (error) {
      const message = (error as Error).message;
      const safe = /^(Computer (kill switch engaged|is leased to a human|capability revoked|does not support navigation)|Key blocked by computer safety policy|Navigation blocked by computer safety policy)$/.test(message);
      return { status: 403, body: { error: safe ? message : 'Computer action failed' } };
    }
  }
}
