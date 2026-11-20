import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [subnet, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) blocked.addSubnet(subnet, prefix, 'ipv4');
for (const [subnet, prefix] of [
  ['::', 96], ['64:ff9b::', 96], ['2001::', 32],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10],
] as const) blocked.addSubnet(subnet, prefix, 'ipv6');

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) {
    // Public unicast IPv6 belongs to 2000::/3. Block local and transition ranges.
    return /^[23][0-9a-f]{3}:/i.test(address) && !blocked.check(address, 'ipv6');
  }
  return false;
}

export type EgressOptions = {
  allowPrivateNetwork?: boolean;
  resolveHost?: (hostname: string) => Promise<string[]>;
};

/** Validate the destination before any credential-bearing provider request. */
export async function assertSafeProviderUrl(url: URL, options: EgressOptions = {}): Promise<void> {
  if (url.username || url.password || url.hash || url.search || !['https:', 'http:'].includes(url.protocol)) {
    throw new Error('Unsafe provider endpoint');
  }
  if (url.hostname === 'api.x.ai' && url.protocol === 'https:') return;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(hostname)
      ? [hostname]
      : await (options.resolveHost ?? (async (host) => (await lookup(host, { all: true })).map((item) => item.address)))(hostname);
  } catch {
    throw new Error('Provider endpoint DNS resolution failed');
  }
  if (addresses.length === 0 || addresses.some((address) => !isIP(address))) {
    throw new Error('Provider endpoint has no valid network address');
  }
  const allPrivate = addresses.every((address) => !isPublicAddress(address));
  if (!options.allowPrivateNetwork && !addresses.every(isPublicAddress)) {
    throw new Error('Private provider endpoint is disabled');
  }
  if (url.protocol !== 'https:' && !(options.allowPrivateNetwork && allPrivate)) {
    throw new Error('Provider endpoint requires HTTPS');
  }
}
