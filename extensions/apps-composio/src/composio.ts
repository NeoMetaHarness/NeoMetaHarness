import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { AppsProvider, AppAction, AppAccount } from '@neometaharness/kernel';
export type ComposioSettings = { endpoint?: string; apiKey?: string };
/** Composio v3 REST boundary: /toolkits, /connected_accounts, /tools/{slug}, /tools/execute/{slug}.
 * https://docs.composio.dev/reference/api-reference -- no vendor SDK or engine modifications. */
export class ComposioProvider implements AppsProvider {
  readonly id = 'composio';
  private accounts: AppAccount[] = [];
  private active = true;
  private readonly shutdown = new AbortController();
  private readonly approvals = new WeakMap<object, string>();
  constructor(private readonly settings: () => ComposioSettings, private readonly file: string,
    private readonly http: typeof fetch = fetch) {}
  async load() { try { this.accounts = JSON.parse(await readFile(this.file, 'utf8')); if (!Array.isArray(this.accounts)) throw Error(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid connected account store'); } }
  private config() {
    if (!this.active) throw new Error('Composio is disabled');
    const settings = this.settings();
    const url = new URL(settings.endpoint || 'https://backend.composio.dev');
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid Composio endpoint');
    if (!settings.apiKey) throw new Error('Configure the Composio API key in extension settings');
    return { endpoint: url.origin, apiKey: settings.apiKey };
  }
  private fingerprint() { return createHash('sha256').update(JSON.stringify(this.config())).digest('hex'); }
  private async request(path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
    const config = this.config();
    try {
      const response = await this.http(config.endpoint + '/api/v3/' + path, { method: body === undefined ? 'GET' : 'POST',
        redirect: 'error', signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
        headers: { 'x-api-key': config.apiKey, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) throw Error();
      const text = await response.text(); if (text.length > 1000000) throw Error();
      const data = JSON.parse(text); if (data.successful === false) throw Error(); return data;
    } catch { throw new Error('Composio request failed; no automatic action retry'); }
  }
  async toolkits() {
    const data = await this.request('toolkits?limit=100');
    if (!Array.isArray(data.items)) throw new Error('Invalid Composio toolkit response');
    return data.items.map((item: any) => ({ id: String(item.slug), name: String(item.name) }));
  }
  async connect(input: { toolkit: string; authConfigId: string; userId: string; callbackUrl: string }) {
    const callback = new URL(input.callbackUrl);
    if ((callback.protocol !== 'https:' && !(callback.protocol === 'http:' && callback.hostname === '127.0.0.1')) || callback.username || callback.password) throw new Error('Invalid OAuth callback URL');
    // Resolve toolkit membership on the service, never trust a caller-supplied account id.
    const auth = await this.request('auth_configs/' + encodeURIComponent(input.authConfigId));
    if (auth.toolkit?.slug !== input.toolkit) throw new Error('Auth configuration does not match toolkit');
    const data = await this.request('connected_accounts', { auth_config: { id: input.authConfigId },
      connection: { user_id: input.userId, redirect_url: input.callbackUrl } });
    const url = new URL(data.redirect_url);
    if (url.protocol !== 'https:' || url.username || url.password || typeof data.id !== 'string' || !data.id) throw new Error('Invalid Composio OAuth response');
    const account = { id: data.id, toolkit: input.toolkit };
    this.accounts.push(account); await mkdir(dirname(this.file), { recursive: true });
    const pending = this.file + '.' + randomUUID() + '.tmp';
    try { await writeFile(pending, JSON.stringify(this.accounts), { mode: 0o600 }); await rename(pending, this.file); }
    finally { await rm(pending, { force: true }); }
    return { ...account, redirectUrl: url.href };
  }
  async describe(input: AppAction) {
    const account = this.accounts.find(a => a.id === input.accountId); if (!account) throw new Error('Account was not connected through Neo');
    const tool = await this.request('tools/' + encodeURIComponent(input.action));
    if (tool.slug !== input.action || tool.toolkit?.slug !== account.toolkit) throw new Error('Action does not match connected toolkit');
    const destructive = !Array.isArray(tool.tags) || !tool.tags.includes('readOnlyHint') || tool.tags.includes('destructiveHint');
    this.approvals.set(input, this.fingerprint());
    return { destructive, summary: `${input.action} on ${account.toolkit} account ${account.id}` };
  }
  async execute(input: AppAction, signal: AbortSignal) {
    // Settings changes invalidate queued approvals before any remote action.
    if (this.approvals.get(input) !== this.fingerprint()) throw new Error('Composio settings changed; request approval again');
    this.approvals.delete(input);
    return this.request('tools/execute/' + encodeURIComponent(input.action), { connected_account_id: input.accountId, arguments: input.arguments }, signal);
  }
  close() { this.active = false; this.shutdown.abort(); }
}
