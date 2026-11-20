import { createHash } from 'node:crypto';
import type { AppsProvider, AppAction, AppsActor, AppEngineGrant } from '@neometaharness/kernel';
import { AccountStore } from './accounts.js';
import { createEgressFetch, validateEgressUrl } from '@neometaharness/egress';
export type ComposioSettings = { endpoint?: string; apiKey?: string; allowPrivateNetwork?: boolean };
// Local policy, never expanded by remote tags. Unknown action identifiers require approval.
const READ_ONLY = new Set(['GITHUB_GET_A_REPOSITORY', 'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER', 'GMAIL_FETCH_EMAILS', 'GMAIL_GET_EMAIL']);
/** Composio v3.1 REST boundary: /toolkits, /connected_accounts, /tools/{slug}, /tools/execute/{slug}.
 * https://docs.composio.dev/reference/api-reference -- no vendor SDK or engine modifications. */
export class ComposioProvider implements AppsProvider {
  readonly id = 'composio';
  readonly accounts: AccountStore;
  private active = true;
  private readonly shutdown = new AbortController();
  private readonly approvals = new WeakMap<object, { fingerprint: string; version: string }>();
  private readonly http: typeof fetch;
  constructor(private readonly settings: () => ComposioSettings, private readonly file: string,
    http?: typeof fetch, private readonly callbackOrigin: () => string = () => { throw new Error('Neo callback origin required'); }) {
    this.accounts = new AccountStore(file); this.http = createEgressFetch(() => this.settings().allowPrivateNetwork === true, http);
  }
  load() { return this.accounts.load(); }
  async authorize(input: AppAction, actor: AppsActor) { this.accounts.authorize(input.accountId, actor); }
  grant(accountId: string, grant: AppEngineGrant, enabled: boolean, actor: AppsActor) { return this.accounts.grant(accountId, grant, enabled, actor); }
  private config() {
    if (!this.active) throw new Error('Composio is disabled');
    const settings = this.settings();
    const url = validateEgressUrl(settings.endpoint || 'https://backend.composio.dev', settings.allowPrivateNetwork === true);
    if (url.search || url.pathname !== '/') throw new Error('Invalid Composio endpoint');
    if (!settings.apiKey) throw new Error('Configure the Composio API key in extension settings');
    return { endpoint: url.origin, apiKey: settings.apiKey, allowPrivateNetwork: settings.allowPrivateNetwork === true };
  }
  private fingerprint() { return createHash('sha256').update(JSON.stringify(this.config())).digest('hex'); }
  private async request(path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
    const config = this.config();
    try {
      const response = await this.http(config.endpoint + '/api/v3.1/' + path, { method: body === undefined ? 'GET' : 'POST',
        redirect: 'error', signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
        headers: { 'x-api-key': config.apiKey, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) throw Error();
      const text = await response.text(); if (text.length > 1000000) throw Error();
      const data = JSON.parse(text); if (data.successful === false) throw Error(); return data;
    } catch { throw new Error('Composio request failed; no automatic action retry'); }
  }
  async toolkits() {
    const result: { id: string; name: string }[] = []; const cursors = new Set<string>(); let cursor = '';
    for (let page = 0; page < 100; page++) {
      const data = await this.request('toolkits?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      if (!Array.isArray(data.items)) throw new Error('Invalid Composio toolkit response');
      for (const item of data.items) { if (typeof item.slug !== 'string' || typeof item.name !== 'string') throw new Error('Invalid Composio toolkit'); result.push({ id: item.slug, name: item.name }); }
      if (!data.next_cursor) return result;
      if (typeof data.next_cursor !== 'string' || cursors.has(data.next_cursor)) throw new Error('Invalid Composio toolkit pagination');
      cursor = data.next_cursor; cursors.add(cursor);
    }
    throw new Error('Composio toolkit pagination exceeded its safety limit');
  }
  async connect(input: { toolkit: string; authConfigId: string; userId: string; workspaceId: string; callbackUrl: string }) {
    if (!input.userId || !input.workspaceId || input.workspaceId === 'default') throw new Error('Apps principal required');
    const callback = new URL(input.callbackUrl);
    if (callback.href !== new URL('/', this.callbackOrigin()).href) throw new Error('OAuth callback must be the Neo Gateway origin');
    // Resolve toolkit membership on the service, never trust a caller-supplied account id.
    const auth = await this.request('auth_configs/' + encodeURIComponent(input.authConfigId));
    if (auth.toolkit?.slug !== input.toolkit) throw new Error('Auth configuration does not match toolkit');
    const entity = createHash('sha256').update(JSON.stringify([input.workspaceId, input.userId])).digest('hex');
    const data = await this.request('connected_accounts/link', { auth_config_id: input.authConfigId, user_id: `neo-${entity}`, callback_url: input.callbackUrl });
    const url = new URL(data.redirect_url);
    if (url.protocol !== 'https:' || url.username || url.password || typeof data.connected_account_id !== 'string' || !data.connected_account_id) throw new Error('Invalid Composio OAuth response');
    const account = { id: data.connected_account_id, toolkit: input.toolkit };
    await this.accounts.add(input.workspaceId, { ...account, ownerUserId: input.userId });
    return { ...account, redirectUrl: url.href };
  }
  async describe(input: AppAction, actor: AppsActor) {
    const fingerprint = this.fingerprint();
    const account = this.accounts.authorize(input.accountId, actor);
    const tool = await this.request('tools/' + encodeURIComponent(input.action));
    if (tool.slug !== input.action || tool.toolkit?.slug !== account.toolkit) throw new Error('Action does not match connected toolkit');
    const destructive = !READ_ONLY.has(input.action) || (Array.isArray(tool.tags) && tool.tags.includes('destructiveHint'));
    if (typeof tool.version !== 'string' || !tool.version) throw new Error('Action version is missing');
    if (fingerprint !== this.fingerprint()) throw new Error('Composio settings changed during review');
    this.approvals.set(input, { fingerprint, version: tool.version });
    return { destructive, summary: `${input.action} on ${account.toolkit} account ${account.id}`, ownerUserId: account.ownerUserId };
  }
  async execute(input: AppAction, signal: AbortSignal) {
    // Settings changes invalidate queued approvals before any remote action.
    const approval = this.approvals.get(input);
    if (!approval || approval.fingerprint !== this.fingerprint()) throw new Error('Composio settings changed; request approval again');
    this.approvals.delete(input);
    return this.request('tools/execute/' + encodeURIComponent(input.action), { connected_account_id: input.accountId, version: approval.version, arguments: input.arguments }, signal);
  }
  close() { this.active = false; this.shutdown.abort(); }
}
