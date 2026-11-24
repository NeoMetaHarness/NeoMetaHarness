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

export function readableDate(value: unknown): { value: string | number } | { label: string } {
  if (value === null || value === undefined || value === '') return { label: 'Never' };
  const timestamp = typeof value === 'number' ? value * 1000 : Date.parse(String(value));
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? { value: date.toISOString() } : { label: 'Unavailable' };
}
