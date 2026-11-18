import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import type { neoContract } from '@neometaharness/contracts';

const { values } = parseArgs({ options: {
  out: { type: 'string' }, url: { type: 'string' },
} });
try {
  if (!values.out) throw new Error('--out is required');
  const token = process.env.NEO_GATEWAY_TOKEN;
  if (!token) throw new Error('NEO_GATEWAY_TOKEN (owner) is required');
  const passphrase = readFileSync(process.env.NEO_BACKUP_PASSPHRASE_FILE ?? 0, 'utf8').trimEnd();
  const rpc = createORPCClient<ContractRouterClient<typeof neoContract>>(new RPCLink({
    url: values.url ?? process.env.NEO_GATEWAY_URL ?? 'http://127.0.0.1:3000',
    headers: { authorization: `Bearer ${token}` },
  }));
  console.log(JSON.stringify(await rpc.system.backup({ out: values.out, passphrase })));
} catch (error) { console.error(error instanceof Error ? error.message : 'Backup failed'); process.exitCode = 1; }
