import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type GatewayEvent } from '@neometaharness/contracts';

const directory = fileURLToPath(new URL('../', import.meta.url));
const repo = resolve(directory, '../..');
const cache = join(directory, '.cache');

type Client = ContractRouterClient<typeof neoContract>;
interface RunningGateway { port: number; token: string; child: ChildProcess; close(): Promise<void> }

async function start(dbFile: string, ownedByPipe = false): Promise<RunningGateway> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: directory,
    // stdin 'ignore' reads as an immediately closed stream, so the default runs also prove
    // that a gateway without NMH_EXIT_ON_STDIN_CLOSE ignores stdin closing (server mode).
    stdio: [ownedByPipe ? 'pipe' : 'ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    env: { ...process.env, NMH_DB_PATH: dbFile, NMH_EXTENSIONS_DIR: join(repo, 'extensions'), NMH_PORT: '0', NEO_MODE: 'desktop', NEO_PRINT_DESKTOP_TOKEN: '1', ...(ownedByPipe ? { NMH_EXIT_ON_STDIN_CLOSE: '1' } : {}) },
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  let token = '';
  const port = await new Promise<number>((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gateway startup timeout: ${stderr}`)), 15000);
    const reader = createInterface({ input: child.stdout! });
    reader.on('line', (line) => {
      if (line.startsWith('NEO_DESKTOP_TOKEN ')) {
        token = line.slice('NEO_DESKTOP_TOKEN '.length).trim();
      }
      if (line.startsWith('GATEWAY_READY ')) {
        clearTimeout(timer);
        reader.close();
        done((JSON.parse(line.slice('GATEWAY_READY '.length)) as { port: number }).port);
      }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Gateway exited ${code}: ${stderr}`)); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  return {
    port,
    token,
    child,
    async close() {
      if (child.exitCode !== null) return;
      const ended = new Promise<void>((done) => child.once('exit', () => done()));
      child.send('shutdown');
      await Promise.race([ended, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Gateway did not exit: ${stderr}`)), 7000))]);
      assert.equal(child.exitCode, 0, `Gateway shutdown failed: ${stderr}`);
    },
  };
}

function connected(port: number, token: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['bearer.' + token]);
  const client = createORPCClient<Client>(new WebSocketLink({ websocket: socket }));
  return { socket, client };
}

async function route(port: number, id: string, token: string) {
  return fetch(`http://127.0.0.1:${port}/x/${id}/hello`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function eventually(check: () => boolean, description: string): Promise<void> {
  for (let retry = 0; retry < 60; retry++) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Never observed ${description}`);
}

async function trial(index: number): Promise<void> {
  const temp = await mkdtemp(join(cache, `trial-${index}-`));
  const db = join(temp, 'state.sqlite');
  let gateway: RunningGateway | undefined;
  try {
    gateway = await start(db);
    const { socket, client } = connected(gateway.port, gateway.token);
    try {
      const http = createORPCClient<Client>(new HttpLink({
        url: `http://127.0.0.1:${gateway.port}`,
        headers: () => ({ authorization: `Bearer ${gateway!.token}` }),
      }));
      const before = await http.extensions.list();
      assert.ok(before.some((extension) => extension.id === 'sample-ts'));
      assert.ok(before.some((extension) => extension.id === 'sample-py'));
      assert.ok(before.every((extension) => extension.status === 'disabled'));

      const seen: GatewayEvent[] = [];
      const streamDone = (async () => {
        for await (const event of await client.events.subscribe({ since: 0 })) {
          seen.push(event);
          if (seen.length >= 6) break;
        }
      })();

      assert.equal((await client.extensions.enable({ id: 'sample-ts' })).status, 'running');
      const py = await client.extensions.enable({ id: 'sample-py' });
      assert.equal(py.status, 'running');
      const pid = py.health?.pid;
      assert.ok(pid && alive(pid), 'Python process is alive');
      assert.equal((await route(gateway.port, 'sample-ts', gateway.token)).status, 200);
      assert.deepEqual(await (await route(gateway.port, 'sample-ts', gateway.token)).json(), { message: 'Hello from TypeScript' });
      assert.deepEqual(await (await route(gateway.port, 'sample-py', gateway.token)).json(), { message: 'Hello from Python' });

      await client.extensions.disable({ id: 'sample-ts' });
      assert.equal((await route(gateway.port, 'sample-ts', gateway.token)).status, 404);
      assert.equal((await route(gateway.port, 'sample-py', gateway.token)).status, 200);
      assert.equal((await client.extensions.list()).find((row) => row.id === 'sample-py')?.health?.ok, true);

      await client.extensions.disable({ id: 'sample-py' });
      await eventually(() => !alive(pid), `Python process ${pid} exited`);
      assert.equal((await route(gateway.port, 'sample-py', gateway.token)).status, 404);

      await client.extensions.enable({ id: 'sample-ts' });
      await client.extensions.enable({ id: 'sample-py' });
      await streamDone;
      assert.deepEqual(seen.filter((event) => event.type === 'extension.state')
        .map(({ extensionId, status }) => `${extensionId}:${status}`), [
        'sample-ts:running', 'sample-py:running', 'sample-ts:disabled',
        'sample-py:disabled', 'sample-ts:running', 'sample-py:running',
      ]);
      assert.deepEqual(seen.map(({ seq }) => seq), [1, 2, 3, 4, 5, 6]);
      console.log(`P1_EVENTS PASS trial=${index} ordered=${seen.length}`);
    } finally { socket.close(); }

    await gateway.close();
    gateway = await start(db);
    const connection = connected(gateway.port, gateway.token);
    try {
      const statuses = await connection.client.extensions.list();
      assert.deepEqual(statuses.filter((row) => row.id.startsWith('sample-')).map((row) => row.status), ['running', 'running']);
      assert.deepEqual(await (await route(gateway.port, 'sample-ts', gateway.token)).json(), { message: 'Hello from TypeScript' });
      assert.deepEqual(await (await route(gateway.port, 'sample-py', gateway.token)).json(), { message: 'Hello from Python' });
      console.log(`P1_PERSISTENCE PASS trial=${index} enabled=2`);
    } finally { connection.socket.close(); }
  } finally {
    await gateway?.close();
    await rm(temp, { recursive: true, force: true });
  }
}

// P1-15: when the desktop shell dies its end of the stdin pipe closes. The gateway must then
// shut down cleanly and take its extension processes with it, so nothing holds neo.sqlite.
async function ownerExit(): Promise<void> {
  const temp = await mkdtemp(join(cache, 'owner-exit-'));
  let gateway: RunningGateway | undefined;
  try {
    gateway = await start(join(temp, 'state.sqlite'), true);
    const { socket, client } = connected(gateway.port, gateway.token);
    let pid: number | undefined;
    try {
      pid = (await client.extensions.enable({ id: 'sample-py' })).health?.pid;
      assert.ok(pid && alive(pid), 'Python process is alive');
    } finally { socket.close(); }
    const exited = new Promise<number | null>((done) => gateway!.child.once('exit', (code) => done(code)));
    gateway.child.stdin!.destroy();
    let timer: NodeJS.Timeout | undefined;
    const code = await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Gateway outlived its closed stdin')), 10000); })])
      .finally(() => clearTimeout(timer));
    assert.equal(code, 0, 'gateway shut down cleanly after stdin closed');
    await eventually(() => !alive(pid!), `Python process ${pid} exited with the gateway`);
    await rm(temp, { recursive: true, force: true });
    console.log('P1_OWNER_EXIT PASS stdin_closed=exit0 extension_processes=0 db_unlocked=true');
  } finally {
    await gateway?.close();
    await rm(temp, { recursive: true, force: true });
  }
}

await mkdir(cache, { recursive: true });
for (let trialNumber = 1; trialNumber <= 2; trialNumber++) await trial(trialNumber);
console.log('P1_LIFECYCLE PASS trials=2');
await ownerExit();
