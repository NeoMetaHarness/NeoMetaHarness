/**
 * Shared outbound HTTP guard for extensions that call admin-configurable provider URLs.
 * Rule: HTTPS only, no credentials in the URL, no redirects, private/reserved addresses denied unless the
 * admin-only `allowPrivateNetwork` setting is on, DNS checked inside the socket lookup (no rebinding gap),
 * bounded response size (maxResponseBytes, default 1 MB) and a timeout that a caller's signal cannot remove. Originally written for apps-composio (P2-12).
 */
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { lookup } from 'node:dns';
import { lookup as lookupAsync } from 'node:dns/promises';
import { request } from 'node:https';
import { Agent, fetch as undiciFetch } from 'undici';

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16]] as const) blocked.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
export function assertPublicEgressAddress(address: string) {
  const family = isIP(address);
  if (!family || (family === 4 ? blocked.check(address, 'ipv4')
    : !globalV6.check(address, 'ipv6') || blocked.check(address, 'ipv6'))) throw new Error('Private or reserved egress address denied');
}
export function validateEgressUrl(input: string | URL, allowPrivateNetwork = false): URL {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Egress requires an HTTPS URL without credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!allowPrivateNetwork) {
    if (isIP(host)) assertPublicEgressAddress(host);
    else if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) throw new Error('Private egress hostname denied');
  }
  return url;
}
export function guardedEgressLookup(allowPrivate: boolean, resolve = lookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true }, (error, addresses) => {
      if (error) { callback(error, [], 0); return; }
      try { if (!addresses.length) throw new Error('Egress hostname has no addresses'); if (!allowPrivate) for (const address of addresses) assertPublicEgressAddress(address.address); }
      catch (error) { callback(error as Error, [], 0); return; }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

/** DNS is checked by the socket lookup itself, avoiding a check-then-resolve rebinding gap.
 * Injected clients are trusted host/test dependencies; URL validation still applies to them. */
export const DEFAULT_EGRESS_TIMEOUT_MS = 30_000;
export const DEFAULT_EGRESS_MAX_RESPONSE_BYTES = 1_000_000;
export interface EgressFetchOptions {
  /** Applies to every request, also when the caller passes its own signal (both abort it). Default 30 s. */
  timeoutMs?: number;
  /** Largest response body accepted; a bigger one fails with "Egress response too large". Default 1 MB. */
  maxResponseBytes?: number;
}

const positive = (value: number | undefined, fallback: number, name: string) => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Egress ${name} must be a positive number`);
  return value;
};

/** Buffer a response body up to the cap, so an injected client is bounded like the built-in one. */
async function capped(response: Response, maxBytes: number): Promise<Response> {
  const tooLarge = () => new Error('Egress response too large');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) { await response.body?.cancel().catch(() => {}); throw tooLarge(); }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) { await reader.cancel().catch(() => {}); throw tooLarge(); }
    chunks.push(value);
  }
  return new Response([204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks),
    { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * The third argument is the options object, or (as before) just the timeout in milliseconds.
 * A caller's own `signal` is combined with the timeout (AbortSignal.any), so it can never disable it.
 */
export function createEgressFetch(allowPrivateNetwork: () => boolean, injected?: typeof fetch,
  options: number | EgressFetchOptions = {}): typeof fetch {
  const settings = typeof options === 'number' ? { timeoutMs: options } : options;
  const timeoutMs = positive(settings.timeoutMs, DEFAULT_EGRESS_TIMEOUT_MS, 'timeoutMs');
  const maxResponseBytes = positive(settings.maxResponseBytes, DEFAULT_EGRESS_MAX_RESPONSE_BYTES, 'maxResponseBytes');
  return (async (input, rawInit) => {
    const allowPrivate = allowPrivateNetwork() === true; // a non-boolean (e.g. the string "false") never opens private egress
    const timeout = AbortSignal.timeout(timeoutMs);
    const init = { ...rawInit, signal: rawInit?.signal ? AbortSignal.any([rawInit.signal, timeout]) : timeout };
    const url = validateEgressUrl(input instanceof Request ? input.url : String(input), allowPrivate);
    if (injected) {
      const response = await injected(url.href, { ...init, redirect: 'error' });
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw new Error('Egress redirect denied');
      return capped(response, maxResponseBytes);
    }
    if (init?.body !== undefined && typeof init.body !== 'string') throw new Error('Unsupported egress body');
    return new Promise<Response>((resolve, reject) => {
      const outgoing = request(url, { method: init?.method ?? 'GET', signal: init?.signal ?? undefined, agent: false,
        headers: Object.fromEntries(new Headers(init?.headers)),
        lookup: guardedEgressLookup(allowPrivate) }, response => {
        if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) { response.destroy(); reject(new Error('Egress redirect denied')); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        response.on('error', reject);
        response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxResponseBytes) { outgoing.destroy(new Error('Egress response too large')); return; } chunks.push(chunk); });
        response.on('end', () => {
          try {
            const headers = new Headers(); for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
            const status = response.statusCode ?? 502;
            resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
          } catch (error) { reject(error); } // Malformed upstream responses must not escape an event callback.
        });
      });
      outgoing.on('error', reject);
      outgoing.end(init?.body);
    });
  }) as typeof fetch;
}

/** Options for credential-bearing provider APIs that also accept streaming multipart bodies. */
export interface ProviderEgressOptions {
  allowPrivateNetwork?: boolean;
  resolveHost?: (hostname: string) => Promise<string[]>;
}

function isPublicProviderAddress(address: string): boolean {
  try { assertPublicEgressAddress(address); return true; }
  catch { return false; }
}

function validateProviderAddresses(addresses: string[], allowPrivate: boolean): void {
  if (!addresses.length || addresses.some(address => !isIP(address))) {
    throw new Error('Provider endpoint has no valid network address');
  }
  if (!allowPrivate && addresses.some(address => !isPublicProviderAddress(address))) {
    throw new Error('Private provider endpoint is disabled');
  }
}

/** Preflight validation. The transport also validates DNS inside its socket lookup. */
export async function assertSafeProviderUrl(url: URL, options: ProviderEgressOptions = {}): Promise<void> {
  if (url.username || url.password || url.hash || url.search || !['https:', 'http:'].includes(url.protocol)) {
    throw new Error('Unsafe provider endpoint');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const allowPrivate = options.allowPrivateNetwork === true;
  if (url.protocol === 'https:' && host === 'api.x.ai') return;
  const resolve = options.resolveHost ?? (async (hostname: string) =>
    (await lookupAsync(hostname, { all: true })).map(entry => entry.address));
  let addresses: string[];
  try { addresses = isIP(host) ? [host] : await resolve(host); }
  catch { throw new Error('Provider endpoint DNS resolution failed'); }
  validateProviderAddresses(addresses, allowPrivate);
  if (url.protocol !== 'https:' && !(allowPrivate && addresses.every(address => !isPublicProviderAddress(address)))) {
    throw new Error('Provider endpoint requires HTTPS');
  }
}

/** Every connected socket is bound to an address checked by the shared egress policy. */
export function createSafeProviderClient(options: ProviderEgressOptions = {}): {
  request(url: string, init: RequestInit): Promise<Response>;
  close(): Promise<void>;
} {
  const allowPrivate = options.allowPrivateNetwork === true;
  const resolve = options.resolveHost ?? (async (hostname: string) =>
    (await lookupAsync(hostname, { all: true })).map(entry => entry.address));
  const dispatcher = new Agent({
    connect: {
      lookup(hostname, lookupOptions, callback) {
        void resolve(hostname).then(addresses => {
          validateProviderAddresses(addresses, allowPrivate);
          const family = typeof lookupOptions === 'object' ? lookupOptions.family : lookupOptions;
          const candidates = addresses.filter(address => !family || isIP(address) === family);
          if (!candidates.length) throw new Error('Provider endpoint address family unavailable');
          const selected = candidates[0]!;
          if (typeof lookupOptions === 'object' && lookupOptions.all) {
            callback(null, [{ address: selected, family: isIP(selected) }]);
          } else {
            callback(null, selected, isIP(selected));
          }
        }).catch(error => {
          callback(error instanceof Error ? error : new Error('Provider endpoint DNS resolution failed'), '', 4);
        });
      },
    },
  });
  return {
    async request(url, init) {
      await assertSafeProviderUrl(new URL(url), options);
      return undiciFetch(url, { ...init, redirect: 'error', dispatcher } as Parameters<typeof undiciFetch>[1]) as Promise<Response>;
    },
    close: () => dispatcher.close(),
  };
}
