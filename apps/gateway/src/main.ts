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
if (gateway.setupToken) {
  // Invite-only server mode: the operator creates the first account with this token.
  console.log('NEO_SETUP_TOKEN ' + gateway.setupToken);
}
console.log('GATEWAY_READY ' + JSON.stringify({ port: gateway.port }));
let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  // Nothing outside may be left to kill a stuck gateway (the shell may be gone), so cap shutdown.
  setTimeout(() => process.exit(1), 15000).unref();
  try {
    await gateway.close();
  } catch (error) {
    console.error('Gateway shutdown failed:', error);
    process.exitCode = 1;
  } finally {
    process.exit();
  }
}
process.on('SIGINT', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
process.on('message', (message) => { if (message === 'shutdown') void close(); });
const stdin = createInterface({ input: process.stdin });
stdin.on('line', (line) => {
  if (line.trim() === 'shutdown') void close();
});
// The desktop shell owns this process through the stdin pipe. When the shell exits for any
// reason (crash, kill, failed setup) the pipe closes, so the gateway must not outlive it.
// Server deployments leave this unset, because their stdin may be /dev/null or a terminal.
if (process.env.NMH_EXIT_ON_STDIN_CLOSE === '1') stdin.on('close', () => { void close(); });
