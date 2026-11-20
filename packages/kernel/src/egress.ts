import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export type EgressResolver = (hostname: string) => Promise<string[]>;

export const systemEgressResolver: EgressResolver = async hostname =>
  (await lookup(hostname, { all: true })).map(result => result.address);

const blocked = new BlockList();
for (const [subnet, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(subnet, prefix, 'ipv4');
for (const [subnet, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(subnet, prefix, 'ipv6');

function unsafeAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const value = mapped ? mapped[1] : address;
  const family = isIP(value);
  if (!family) return true;
  return blocked.check(value, family === 4 ? 'ipv4' : 'ipv6');
}

/** Reusable HTTPS egress validation. The approved IP must be pinned by the transport. */
export async function approveHttpsEgress(
  value: string,
  allowPrivateNetwork = false,
  resolveHost: EgressResolver = systemEgressResolver,
): Promise<{ url: string; address: string; family: 4 | 6 }> {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('Custom endpoint requires HTTPS without embedded credentials, query or fragment');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolveHost(host);
  if (!addresses.length || addresses.some(address => !isIP(address))) {
    throw new Error('Endpoint hostname has no valid DNS addresses');
  }
  if (!allowPrivateNetwork && addresses.some(unsafeAddress)) {
    throw new Error('Endpoint resolves to a forbidden private or metadata address');
  }
  const address = addresses[0];
  return { url: url.href.replace(/\/$/, ''), address, family: isIP(address) as 4 | 6 };
}
