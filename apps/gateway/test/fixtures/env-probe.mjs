// SEC-10 fixture: a newline-delimited JSON-RPC process extension that reports
// which environment variable names it received from the gateway.
import { createInterface } from 'node:readline';

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method } = JSON.parse(line);
  if (method === 'initialize') reply(id, { routes: [{ path: 'env' }], contributions: [] });
  else if (method === 'health') reply(id, { ok: true, pid: process.pid });
  else if (method === 'route.invoke') reply(id, { names: Object.keys(process.env), hasPath: Boolean(process.env.PATH ?? process.env.Path) });
  else if (method === 'shutdown') { reply(id, { ok: true }); process.exit(0); }
});
