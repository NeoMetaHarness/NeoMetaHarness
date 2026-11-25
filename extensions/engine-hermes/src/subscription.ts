type DashboardRequest = (path: string, method?: string) => Promise<Response>;
const providerPath = '/api/providers/oauth/openai-codex';
class SessionNotFound extends Error {}

export interface SubscriptionStatus {
  sessionId: string;
  status: 'pending' | 'approved' | 'expired' | 'cancelled' | 'denied' | 'error';
  signedIn: boolean;
  accountLabel?: string;
}

/** Hermes owns the device exchange, polling and credential persistence.
 * Dashboard seam: hermes_cli/web_routers/oauth.py:841,921,975 (v0.23.2).
 */
export class HermesSubscription {
  constructor(private readonly request: DashboardRequest) {}

  private async call(path: string, method?: string): Promise<Record<string, unknown>> {
    try {
      const response = await this.request(path, method);
      if (response.status === 404 && path.startsWith(providerPath + '/poll/')) throw new SessionNotFound('Hermes sign-in session not found');
      if (!response.ok) throw new Error('Invalid response');
      return await response.json() as Record<string, unknown>;
    } catch (error) {
      if (error instanceof SessionNotFound) throw error;
      throw new Error('Hermes subscription sign-in request failed');
    }
  }

  private query(profile: string): string {
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(profile)) throw new Error('Invalid Hermes profile name');
    return profile === 'default' ? '' : '?profile=' + encodeURIComponent(profile);
  }

  private session(sessionId: unknown): string {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      throw new Error('Invalid Hermes sign-in session');
    }
    return sessionId;
  }

  async start(profile: string) {
    const reply = await this.call(providerPath + '/start' + this.query(profile), 'POST');
    const sessionId = this.session(reply.session_id);
    if (reply.flow !== 'device_code' || typeof reply.user_code !== 'string'
      || reply.verification_url !== 'https://auth.openai.com/codex/device'
      || typeof reply.expires_in !== 'number' || reply.expires_in <= 0
      || typeof reply.poll_interval !== 'number' || reply.poll_interval <= 0) {
      throw new Error('Invalid Hermes device-code response');
    }
    return { sessionId, userCode: reply.user_code, verificationUrl: reply.verification_url,
      expiresIn: reply.expires_in, pollInterval: reply.poll_interval };
  }

  async poll(profile: string, sessionId: string): Promise<SubscriptionStatus> {
    const reply = await this.call(providerPath + '/poll/' + this.session(sessionId) + this.query(profile));
    if (reply.session_id !== sessionId) throw new Error('Hermes sign-in session mismatch');
    const status = reply.status;
    if (status !== 'pending' && status !== 'approved' && status !== 'expired'
      && status !== 'cancelled' && status !== 'denied' && status !== 'error') {
      throw new Error('Invalid Hermes sign-in status');
    }
    // The pinned Codex worker does not supply an account email.
    return { sessionId, status, signedIn: status === 'approved',
      ...(status === 'approved' ? { accountLabel: 'ChatGPT / Codex' } : {}) };
  }

  private async providerSignedIn(profile: string): Promise<boolean | undefined> {
    const { providers } = await this.call('/api/providers/oauth' + this.query(profile));
    const provider = Array.isArray(providers) ? providers.find((item) => item?.id === 'openai-codex') : undefined;
    const signedIn = provider?.status?.logged_in;
    return typeof signedIn === 'boolean' ? signedIn : undefined;
  }

  async cancel(profile: string, sessionId: string): Promise<SubscriptionStatus> {
    const current = await this.poll(profile, sessionId);
    if (current.status !== 'pending') return current;
    const before = await this.providerSignedIn(profile);
    const reply = await this.call('/api/providers/oauth/sessions/' + this.session(sessionId) + this.query(profile), 'DELETE');
    const cancelled = reply.ok === true && reply.session_id === sessionId;
    try {
      const final = await this.poll(profile, sessionId);
      if (final.status !== 'pending') return final;
    } catch (error) {
      if (!(error instanceof SessionNotFound)) throw error;
      // The pinned dashboard removes the session on DELETE, even after approval.
      // In that case the profile's native provider status is the remaining evidence.
      if (cancelled || (reply.ok === false && reply.message === 'session not found')) {
        const after = await this.providerSignedIn(profile);
        if (before === false && after === true) {
          return { sessionId, status: 'approved', signedIn: true, accountLabel: 'ChatGPT / Codex' };
        }
        if (after === false || (before === true && after === true)) {
          return { sessionId, status: 'cancelled', signedIn: after };
        }
        throw new Error('Hermes sign-in cancellation outcome is indeterminate');
      }
    }
    throw new Error('Hermes sign-in cancellation failed');
  }
}
