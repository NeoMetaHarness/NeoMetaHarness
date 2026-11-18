import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { gatewayToken, gatewayUrl } from '../config';

export type HermesClient = ContractRouterClient<typeof neoContract>;
export const hermesRpc = createORPCClient<HermesClient>(new RPCLink({
  url: gatewayUrl(),
  headers: () => {
    const token = gatewayToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  },
}));

export function engineDisabled(error: unknown): boolean {
  const reason = error as { status?: number; code?: string } | null;
  return reason?.status === 404 || reason?.code === 'NOT_FOUND' || /\b(404|disabled|not.found)\b/i.test(String(error));
}

export function readableDate(value: unknown): string {
  if (!value) return 'Never';
  const timestamp = typeof value === 'number' ? value * 1000 : Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : String(value);
}
