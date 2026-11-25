type AuthRpc = (method: 'server.getConfig' | 'provider.auth.start', input: object) => Promise<unknown>;
type AuthSnapshot = (instanceId: string) => Promise<unknown>;

type ProviderSnapshot = {
  instanceId: string;
  driver: 'codex' | 'claudeAgent';
  enabled?: boolean;
  setup?: { canAuthenticate?: boolean };
  auth?: { status?: string; type?: string; label?: string; subscriptionSharing?: boolean };
};

const phases = ['idle', 'starting', 'waiting', 'verifying', 'succeeded', 'failed', 'cancelled'] as const;
type Phase = typeof phases[number];
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id);

function metadata(provider: ProviderSnapshot) {
  const auth = provider.auth;
  const status = auth?.status === 'authenticated' || auth?.status === 'unauthenticated' ? auth.status : 'unknown';
  const isCodex = provider.driver === 'codex';
  const subscription = isCodex ? auth?.type === 'chatgpt' || auth?.subscriptionSharing === true
    : !['apiKey', 'bedrock', 'customEndpoint'].includes(auth?.type ?? '');
  const signedIn = status === 'authenticated' && subscription;
  const canStart = isCodex && provider.enabled === true && provider.setup?.canAuthenticate === true;
  const guidance = isCodex
    ? (canStart ? 'Sign in with ChatGPT through T3.' : 'Configure a managed Codex provider in T3 to sign in with ChatGPT.')
    : (signedIn ? 'Claude sign-in detected by T3.' : 'Sign in to Claude Code in the isolated T3 environment using claude auth login, then refresh.');
  return { instanceId: provider.instanceId, provider: isCodex ? 'codex' as const : 'claude' as const,
    status, signedIn, canStart, accountLabel: signedIn ? (isCodex ? 'ChatGPT / Codex' : 'Claude') : null, guidance };
}

function projectFlow(raw: unknown, instanceId: string) {
  const state = raw as { instanceId?: string; phase?: Phase; flowId?: string; expiresAt?: string;
    interaction?: { type?: string; url?: string; userCode?: string } } | null;
  if (state?.instanceId !== instanceId || !state.phase || !phases.includes(state.phase)) {
    throw new Error('T3 returned an invalid sign-in state.');
  }
  const interaction = state.interaction;
  let verificationUrl: string | null = null;
  if ((interaction?.type === 'browser' || interaction?.type === 'deviceCode') && typeof interaction.url === 'string') {
    const url = new URL(interaction.url);
    if (url.protocol === 'https:' && !url.username && !url.password) {
      url.searchParams.delete('id_token_hint');
      url.searchParams.delete('login_hint');
      verificationUrl = url.href;
    }
  }
  return { instanceId, phase: state.phase, flowId: typeof state.flowId === 'string' ? state.flowId : null,
    expiresAt: typeof state.expiresAt === 'string' ? state.expiresAt : null, verificationUrl,
    userCode: interaction?.type === 'deviceCode' && typeof interaction.userCode === 'string' ? interaction.userCode : null };
}

/** T3 v0.1.9 server.getConfig and provider.auth.start/subscribe. Never read provider homes. */
export class T3Subscription {
  constructor(private readonly request: AuthRpc, private readonly snapshot: AuthSnapshot) {}

  private async providers(): Promise<ProviderSnapshot[]> {
    const config = await this.request('server.getConfig', {}) as { providers?: ProviderSnapshot[] } | null;
    return (Array.isArray(config?.providers) ? config.providers : []).filter((provider) =>
      validId(provider?.instanceId) && (provider.driver === 'codex' || provider.driver === 'claudeAgent'));
  }

  async status(local = true) {
    return { providers: (await this.providers()).map((provider) => {
      const result = metadata(provider);
      if (local || result.provider !== 'codex') return result;
      return { ...result, canStart: false, guidance: 'ChatGPT sign-in requires the isolated local T3 server.' };
    }) };
  }

  private async codex(instanceId: string) {
    const provider = (await this.providers()).find((item) => item.instanceId === instanceId);
    if (!provider || !metadata(provider).canStart) throw new Error('T3 does not support ChatGPT sign-in for this provider.');
  }

  async start(instanceId: string) {
    await this.codex(instanceId);
    try {
      return projectFlow(await this.request('provider.auth.start', { instanceId, methodId: 'chatgpt', callbackMode: 'server' }), instanceId);
    } catch { throw new Error('T3 could not start ChatGPT sign-in.'); }
  }

  async poll(instanceId: string) {
    await this.codex(instanceId);
    try { return projectFlow(await this.snapshot(instanceId), instanceId); }
    catch { throw new Error('T3 could not read ChatGPT sign-in status.'); }
  }
}
