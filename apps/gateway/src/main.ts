import { startGateway } from './server.js';
import { createInterface } from 'node:readline';

const gateway = await startGateway({
  databaseFile: process.env.NMH_DB_PATH ?? './.cache/neo.sqlite',
  extensionsDir: process.env.NMH_EXTENSIONS_DIR,
  port: Number(process.env.NMH_PORT ?? 0),
});

console.log('GATEWAY_READY ' + JSON.stringify({ port: gateway.port }));
let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await gateway.close();
  process.exit(0);
}
process.on('SIGINT', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
process.on('message', (message) => { if (message === 'shutdown') void close(); });
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === 'shutdown') void close();
});
