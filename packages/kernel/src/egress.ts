import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns';
import { request } from 'node:https';

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::', 32], ['2001:db8::', 32], ['2002::', 16]] as const) blocked.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
export function assertPublicEgressAddress(address: string) {
  const family = isIP(address);
  if (!family || (family === 4 ? blocked.check(address, 'ipv4')
    : !globalV6.check(address, 'ipv6') || blocked.check(address, 'ipv6'))) throw new Error('Private or reserved egress address denied');
}
export function validateEgressUrl(input: string | URL, allowPrivateNetwork = false): URL {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Egress requires an HTTPS URL without credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!allowPrivateNetwork) {
    if (isIP(host)) assertPublicEgressAddress(host);
    else if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) throw new Error('Private egress hostname denied');
  }
  return url;
}

/** DNS is checked by the socket lookup itself, avoiding a check-then-resolve rebinding gap.
 * Injected clients are trusted host/test dependencies; URL validation still applies to them. */
export function createEgressFetch(allowPrivateNetwork: () => boolean, injected?: typeof fetch): typeof fetch {
  return (async (input, init) => {
    const allowPrivate = allowPrivateNetwork();
    const url = validateEgressUrl(input instanceof Request ? input.url : String(input), allowPrivate);
    if (injected) {
      const response = await injected(url.href, { ...init, redirect: 'error' });
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw new Error('Egress redirect denied');
      return response;
    }
    if (init?.body !== undefined && typeof init.body !== 'string') throw new Error('Unsupported egress body');
    return new Promise<Response>((resolve, reject) => {
      const outgoing = request(url, { method: init?.method ?? 'GET', signal: init?.signal ?? undefined,
        headers: Object.fromEntries(new Headers(init?.headers)),
        lookup: (hostname, options, callback) => {
          lookup(hostname, { all: true }, (error, addresses) => {
            if (error) { callback(error, [], 0); return; }
            try { if (!addresses.length) throw new Error('Egress hostname has no addresses'); if (!allowPrivate) for (const address of addresses) assertPublicEgressAddress(address.address); }
            catch (error) { callback(error as Error, [], 0); return; }
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0]!.address, addresses[0]!.family);
          });
        } }, response => {
        if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) { response.destroy(); reject(new Error('Egress redirect denied')); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        response.on('error', reject);
        response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1_000_000) { outgoing.destroy(new Error('Egress response too large')); return; } chunks.push(chunk); });
        response.on('end', () => { const headers = new Headers(); for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers })); });
      });
      outgoing.on('error', reject);
      outgoing.end(init?.body);
    });
  }) as typeof fetch;
}
