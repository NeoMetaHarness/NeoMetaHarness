/** Optional computer MCP projection. Engines remain usable when its extension is disabled. */
export type ComputerEngine = 'hermes' | 'dsh' | 'superagent';
export interface ComputerMcpConfig { transport: 'stdio'; serverName: string; command: string; args: string[]; env: Record<string, string> }
export interface ComputerMcpProjection {
  ready(engine: ComputerEngine, profile: string, home: string, workspace: string): Promise<ComputerMcpConfig>;
  forget(engine: ComputerEngine, profile: string, workspace?: string): Promise<void>;
  removeAll(): Promise<void>;
}
export class ComputerMcpBridge {
  private projection?: ComputerMcpProjection;
  private readonly consumers = new Map<string, { engine: ComputerEngine; profile: string; home: string; workspace: string }>();
  async attach(projection: ComputerMcpProjection) {
    if (this.projection) throw new Error('Computer MCP projection already attached');
    this.projection = projection;
    try { for (const value of this.consumers.values()) await projection.ready(value.engine, value.profile, value.home, value.workspace); }
    catch (error) { this.projection = undefined; await projection.removeAll(); throw error; }
  }
  async detach(projection: ComputerMcpProjection) {
    if (this.projection !== projection) return;
    this.projection = undefined; await projection.removeAll();
  }
  async ready(engine: ComputerEngine, profile: string, home: string, workspace: string): Promise<ComputerMcpConfig | undefined> {
    this.consumers.set(JSON.stringify([engine, profile, workspace]), { engine, profile, home, workspace });
    return this.projection?.ready(engine, profile, home, workspace);
  }
  async forgetEngine(engine: ComputerEngine) {
    for (const value of [...this.consumers.values()]) if (value.engine === engine) await this.forget(engine, value.profile, value.workspace);
  }
  async forget(engine: ComputerEngine, profile: string, workspace?: string) {
    for (const [key, value] of [...this.consumers]) {
      if (value.engine !== engine || value.profile !== profile || (workspace && value.workspace !== workspace)) continue;
      this.consumers.delete(key);
      await this.projection?.forget(engine, profile, value.workspace);
    }
  }
}
