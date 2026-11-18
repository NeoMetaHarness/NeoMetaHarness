// ACP stdio transport only. Gateway extension owns all execution and credentials.
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [endpoint, tokenFile] = process.argv.slice(2);
const token = readFileSync(tokenFile, 'utf8');
const socket = connect(endpoint);
const write = (message) => process.stdout.write(JSON.stringify(message) + '\n');
socket.on('error', () => process.exit(1));
socket.on('close', () => process.exit(0));
createInterface({ input: socket }).on('line', (line) => {
  try { write(JSON.parse(line)); } catch { process.exit(1); }
});
createInterface({ input: process.stdin }).on('line', (line) => {
  try {
    const message = JSON.parse(line);
    socket.write(JSON.stringify({ token, message }) + '\n');
  } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); }
});
process.stdin.on('end', () => socket.end());
