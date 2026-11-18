import { startGateway } from './server.js';
import { createInterface } from 'node:readline';

const mode = (process.env.NEO_MODE as 'desktop' | 'server') ?? (process.env.NMH_DESKTOP_DATA_DIR ? 'desktop' : 'server');

const gateway = await startGateway({
  databaseFile: process.env.NMH_DB_PATH ?? './.cache/neo.sqlite',
  extensionsDir: process.env.NMH_EXTENSIONS_DIR,
  port: Number(process.env.NMH_PORT ?? 0),
  mode,
});

if (gateway.desktopToken && process.env.NEO_PRINT_DESKTOP_TOKEN === '1') {
  console.log('NEO_DESKTOP_TOKEN ' + gateway.desktopToken);
}
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
