/** Provider-neutral connected apps. User identity and roles come from the Gateway. */
export type AppToolkit = { id: string; name: string };
export type AppAccount = { id: string; toolkit: string };
export type AppAction = { provider: string; accountId: string; action: string; arguments: Record<string, unknown> };
export interface AppsProvider {
  id: string;
  toolkits(): Promise<AppToolkit[]>;
  connect(input: { toolkit: string; authConfigId: string; userId: string; callbackUrl: string }): Promise<AppAccount & { redirectUrl: string }>;
  describe(input: AppAction): Promise<{ destructive: boolean; summary: string }>;
  execute(input: AppAction, signal: AbortSignal): Promise<unknown>;
}
export type AppApproval = { request: AppAction; destructive: boolean; summary: string; execute(): Promise<unknown> };
export interface AppsApprovalGate { submit(input: AppApproval): Promise<unknown> }
export class AppsRegistry {
  private readonly providers = new Map<string, AppsProvider>();
  private gate?: AppsApprovalGate;
  private readonly pending = new Set<AbortController>();
  register(provider: AppsProvider) {
    if (this.providers.has(provider.id)) throw new Error('Apps provider already registered');
    this.providers.set(provider.id, provider);
    return () => { if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id); for (const job of this.pending) job.abort(); };
  }
  attachGate(gate: AppsApprovalGate) { if (this.gate) throw new Error('Apps approval gate already attached'); this.gate = gate; return () => { if (this.gate === gate) this.gate = undefined; }; }
  private provider(id: string) { const value = this.providers.get(id); if (!value) throw new Error('Apps provider disabled or unavailable'); return value; }
  async toolkits(provider: string) { return this.provider(provider).toolkits(); }
  async connect(provider: string, input: Parameters<AppsProvider['connect']>[0]) { return this.provider(provider).connect(input); }
  async run(request: AppAction) {
    const copy = structuredClone(request);
    const provider = this.provider(copy.provider);
    const gate = this.gate; if (!gate) throw new Error('Apps actions require an enabled Inbox approval service');
    const detail = await provider.describe(copy);
    const serialized = JSON.stringify(copy);
    return gate.submit({ request: copy, ...detail, execute: async () => {
      if (JSON.stringify(copy) !== serialized) throw new Error('Apps action changed after approval');
      if (this.providers.get(copy.provider) !== provider || this.gate !== gate) throw new Error('Apps action approval expired; request it again');
      const controller = new AbortController(); this.pending.add(controller);
      try { return await provider.execute(copy, controller.signal); }
      finally { this.pending.delete(controller); }
    } });
  }
}
