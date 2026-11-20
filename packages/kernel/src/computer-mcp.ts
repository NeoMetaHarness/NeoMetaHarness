export class McpProfileNotFoundError extends Error {}
/** Optional computer MCP projection. Engines remain usable when its extension is disabled. */
export type ComputerEngine = 'hermes' | 'dsh' | 'superagent';
export interface ComputerMcpConfig { transport: 'stdio'; serverName: string; command: string; args: string[]; env: Record<string, string> }
export interface ComputerMcpProjection {
  ready(engine: ComputerEngine, profile: string, home: string, workspace: string): Promise<ComputerMcpConfig>;
  forget(engine: ComputerEngine, profile: string, workspace?: string): Promise<void>;
  removeAll(): Promise<void>;
}
export class McpProjectionBridge {
  private readonly workspaces = new Map<string, string>();
  private readonly unscoped = new Map<string, { engine: ComputerEngine; profile: string; home: string }>();
  constructor(private readonly options: { requireWorkspace?: boolean } = {}) {}
  async bindWorkspace(engine: ComputerEngine, profile: string, workspace: string) {
    if (!workspace || workspace === 'default' || !profile) throw new Error('Explicit MCP workspace required');
    const key = JSON.stringify([engine, profile]);
    const previous = this.workspaces.get(key) ?? this.consumers.get(key)?.workspace;
    if (previous && previous !== workspace) throw new McpProfileNotFoundError('MCP profile belongs to another workspace');
    this.workspaces.set(key, workspace);
    const waiting = this.unscoped.get(key);
    if (waiting) { this.unscoped.delete(key); await this.ready(engine, profile, waiting.home, workspace); }
  }
  private projection?: ComputerMcpProjection;
  private readonly consumers = new Map<string, { engine: ComputerEngine; profile: string; home: string; workspace: string }>();
  async attach(projection: ComputerMcpProjection) {
    if (this.projection) throw new Error('MCP projection already attached');
    this.projection = projection;
    try { for (const value of this.consumers.values()) await projection.ready(value.engine, value.profile, value.home, value.workspace); }
    catch (error) { this.projection = undefined; await projection.removeAll(); throw error; }
  }
  async detach(projection: ComputerMcpProjection) {
    if (this.projection !== projection) return;
    this.projection = undefined; await projection.removeAll();
  }
  async ready(engine: ComputerEngine, profile: string, home: string, workspace?: string): Promise<ComputerMcpConfig | undefined> {
    const key = JSON.stringify([engine, profile]);
    if (this.options.requireWorkspace) {
      workspace ??= this.workspaces.get(key);
      if (!workspace || workspace === 'default') { this.unscoped.set(key, { engine, profile, home }); return undefined; }
      await this.bindWorkspace(engine, profile, workspace);
    }
    workspace ??= 'default';
    this.consumers.set(JSON.stringify([engine, profile, workspace]), { engine, profile, home, workspace });
    return this.projection?.ready(engine, profile, home, workspace);
  }
  async forgetEngine(engine: ComputerEngine) {
    for (const [key, value] of this.unscoped) if (value.engine === engine) this.unscoped.delete(key);
    for (const value of [...this.consumers.values()]) if (value.engine === engine) await this.forget(engine, value.profile, value.workspace);
  }
  async forget(engine: ComputerEngine, profile: string, workspace?: string) {
    this.unscoped.delete(JSON.stringify([engine, profile]));
    for (const [key, value] of [...this.consumers]) {
      if (value.engine !== engine || value.profile !== profile || (workspace && value.workspace !== workspace)) continue;
      this.consumers.delete(key);
      await this.projection?.forget(engine, profile, value.workspace);
    }
  }
}

/** Compatibility name for the computer projection. */
export class ComputerMcpBridge extends McpProjectionBridge {}

export type McpEngine = ComputerEngine;
export type McpConfig = ComputerMcpConfig;
export type McpProjection = ComputerMcpProjection;
