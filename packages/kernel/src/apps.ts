export class AppsAccountNotFoundError extends Error {}
/** Provider-neutral connected apps. User identity and roles come from the Gateway. */
export type AppToolkit = { id: string; name: string };
export type AppAccount = { id: string; toolkit: string };
export type AppAction = { provider: string; accountId: string; action: string; arguments: Record<string, unknown> };
export type AppsActor = { workspaceId: string } & ({ kind: 'user'; userId: string } | { kind: 'engine'; engine: 'hermes' | 'dsh' | 'superagent'; profile: string });
export type AppEngineGrant = { engine: 'hermes' | 'dsh' | 'superagent'; profile: string };
export interface AppsProvider {
  id: string;
  toolkits(): Promise<AppToolkit[]>;
  connect(input: { toolkit: string; authConfigId: string; userId: string; workspaceId: string; callbackUrl: string }): Promise<AppAccount & { redirectUrl: string }>;
  authorize(input: AppAction, actor: AppsActor): Promise<void>;
  grant?(accountId: string, grant: AppEngineGrant, enabled: boolean, actor: AppsActor): Promise<void>;
  describe(input: AppAction, actor: AppsActor): Promise<{ destructive: boolean; summary: string }>;
  execute(input: AppAction, signal: AbortSignal, actor: AppsActor): Promise<unknown>;
}
export type AppApproval = { request: AppAction; actor: AppsActor; destructive: boolean; summary: string; execute(): Promise<unknown> };
export interface AppsApprovalGate { submit(input: AppApproval): Promise<unknown> }
export class AppsRegistry {
  private readonly providers = new Map<string, AppsProvider>();
  private gate?: AppsApprovalGate;
  private readonly pending = new Map<AbortController, AppsProvider>();
  register(provider: AppsProvider) {
    if (this.providers.has(provider.id)) throw new Error('Apps provider already registered');
    this.providers.set(provider.id, provider);
    return () => { if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id); for (const [job, owner] of this.pending) if (owner === provider) job.abort(); };
  }
  attachGate(gate: AppsApprovalGate) { if (this.gate) throw new Error('Apps approval gate already attached'); this.gate = gate; return () => { if (this.gate === gate) this.gate = undefined; }; }
  private provider(id: string) { const value = this.providers.get(id); if (!value) throw new Error('Apps provider disabled or unavailable'); return value; }
  async toolkits(provider: string) { return this.provider(provider).toolkits(); }
  async connect(provider: string, input: Parameters<AppsProvider['connect']>[0]) { return this.provider(provider).connect(input); }
  async grant(provider: string, accountId: string, grant: AppEngineGrant, enabled: boolean, actor: AppsActor, beforeGrant?: () => Promise<void>) {
    const target = this.provider(provider); if (!target.grant) throw new Error('Apps provider does not support grants');
    if (actor.kind !== 'user') throw new Error('Only account owners can grant access');
    await target.authorize({ provider, accountId, action: 'grant', arguments: {} }, actor);
    if (enabled) await beforeGrant?.();
    await target.grant(accountId, grant, enabled, actor);
  }
  async run(request: AppAction, actor: AppsActor) {
    if (!actor?.workspaceId || actor.workspaceId === 'default' || (actor.kind === 'user' ? !actor.userId : !actor.profile)) throw new Error('Apps principal required');
    const copy = structuredClone(request);
    const principal = structuredClone(actor);
    const provider = this.provider(copy.provider);
    const gate = this.gate; if (!gate) throw new Error('Apps actions require an enabled Inbox approval service');
    await provider.authorize(copy, principal);
    const detail = await provider.describe(copy, principal);
    const serialized = JSON.stringify(copy);
    const review = structuredClone(copy);
    return gate.submit({ request: review, actor: structuredClone(principal), ...detail, execute: async () => {
      if (JSON.stringify(review) !== serialized || JSON.stringify(copy) !== serialized) throw new Error('Apps action changed after approval');
      if (this.providers.get(copy.provider) !== provider || this.gate !== gate) throw new Error('Apps action approval expired; request it again');
      await provider.authorize(copy, principal);
      const controller = new AbortController(); this.pending.set(controller, provider);
      try { return await provider.execute(copy, controller.signal, principal); }
      finally { this.pending.delete(controller); }
    } });
  }
}
