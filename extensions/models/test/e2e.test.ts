import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { WebSocket } from 'ws';
import { createORPCClient } from '@orpc/client';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { requireUpstreamCache } from '../../../tests/upstream-cache.mjs';
requireUpstreamCache('extensions/models/test/e2e.test.ts', ['hermes-agent']);

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
type Client = ContractRouterClient<typeof neoContract>;

async function bounded<T>(operation: Promise<T>, timeout: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), timeout);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fakeOpenAI(label: string, secret: string): Promise<{ server: Server; port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model' }] }));
      return;
    }
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${secret}`) {
      res.writeHead(401).end('Incorrect provider credential');
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const input = JSON.parse(Buffer.concat(chunks).toString()) as { stream?: boolean };
      hits.push(label);
      const message = { role: 'assistant', content: `${label} completed` };
      if (!input.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: label, object: 'chat.completion', model: 'fake-model',
          choices: [{ index: 0, message, finish_reason: 'stop' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta: object, finish_reason: string | null = null) => {
        res.write('data: ' + JSON.stringify({ id: label, object: 'chat.completion.chunk', created: 1,
          model: 'fake-model', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
      };
      send({ role: 'assistant', content: `${label} completed` });
      send({}, 'stop');
      res.end('data: [DONE]\n\n');
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end('Invalid fake request');
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, port: address.port, hits };
}

async function gateway(home: string, fallbackUrl: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: join(repo, 'apps/gateway'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NMH_HERMES_HOME: home, NMH_HERMES_MODEL_URL: fallbackUrl,
      NMH_DB_PATH: join(home, 'neo.sqlite'), NMH_EXTENSIONS_DIR: join(repo, 'extensions'),
      NMH_PORT: '0', NEO_MODE: 'desktop', NEO_PRINT_DESKTOP_TOKEN: '1' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-200_000); });
  child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-200_000); });
  let token = '';
  const port = await bounded(new Promise<number>((done, reject) => {
    const reader = createInterface({ input: child.stdout! });
    reader.on('line', (line) => {
      if (line.startsWith('NEO_DESKTOP_TOKEN ')) token = line.slice(18).trim();
      if (line.startsWith('GATEWAY_READY ')) {
        reader.close();
        done((JSON.parse(line.slice(14)) as { port: number }).port);
      }
    });
    child.once('exit', (code) => reject(new Error(`Gateway exited ${code}: ${stderr.slice(-1000)}`)));
    child.once('error', reject);
  }), 30_000, 'gateway startup');
  assert.ok(token.length > 16);
  return { child, port, token, logs: () => stdout + stderr };
}

async function main() {
  const temp = await mkdtemp(join(tmpdir(), 'nmh-model-hub-'));
  const home = join(temp, 'hermes');
  const keyA = 'TEST_ONLY_PROVIDER_A_DO_NOT_LOG_42';
  const keyB = 'TEST_ONLY_PROVIDER_B_DO_NOT_LOG_84';
  const a = await fakeOpenAI('A', keyA);
  const b = await fakeOpenAI('B', keyB);
  let app: Awaited<ReturnType<typeof gateway>> | undefined;
  let socket: WebSocket | undefined;
  try {
    app = await gateway(home, `http://127.0.0.1:${a.port}/v1`);
    const base = `http://127.0.0.1:${app.port}`;
    const auth = { authorization: `Bearer ${app.token}` };
    const http = createORPCClient<Client>(new HttpLink({ url: base, headers: () => auth }));
    assert.equal((await fetch(base + '/x/models/providers/list')).status, 401);
    assert.equal((await http.extensions.enable({ id: 'sample-ts' })).status, 'running');
    assert.equal((await http.extensions.enable({ id: 'models' })).status, 'running');
    const providerA = await http.x.models.providers.put({ id: 'fake-a', kind: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${a.port}/v1`, apiKey: keyA });
    const providerB = await http.x.models.providers.put({ id: 'fake-b', kind: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${b.port}/v1`, apiKey: keyB });
    assert.ok(providerA.hasKey && providerB.hasKey);
    assert.equal((await http.x.models.providers.list()).length, 2);
    assert.deepEqual((await http.x.models.roles.set({ role: 'default', providerId: 'fake-a', model: 'fake-model' })).selection,
      { providerId: 'fake-a', model: 'fake-model' });
    assert.equal((await http.x.models.roles.get()).default?.providerId, 'fake-a');
    await http.x.models.override.set({ profile: 'bot2', providerId: 'fake-b', model: 'fake-model' });
    const settings = await readFile(join(home, 'extensions', 'models', 'models', 'settings.json'), 'utf8');
    assert.ok(!settings.includes(keyA) && !settings.includes(keyB), 'keys must stay in vault');

    const enabled = await http.extensions.enable({ id: 'engine-hermes' });
    assert.equal(enabled.status, 'running', enabled.reason + ' ' + app.logs().slice(-1000));
    await http.x['engine-hermes'].profiles.create({ name: 'bot1' });
    await http.x['engine-hermes'].profiles.create({ name: 'bot2' });
    socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, ['bearer.' + app.token]);
    const ws = createORPCClient<Client>(new WebSocketLink({ websocket: socket }));
    for (const [profile, server] of [['bot1', a], ['bot2', b]] as const) {
      const before = server.hits.length;
      const run = await bounded(http.x['engine-hermes'].runs.start({ profile, input: `${profile} say hello` }), 60_000, `start ${profile}`);
      const receive = (async () => {
        for await (const event of await ws.x['engine-hermes'].runs.events({ profile, runId: run.run_id })) {
          if (event.type === 'run.completed') return;
          if (event.type === 'run.failed' || event.type === 'run.cancelled') {
            throw new Error(`Hermes ${profile} ${event.type}: ${JSON.stringify(event.payload).slice(-800)}`);
          }
        }
        throw new Error(`Hermes ${profile} stream ended without completion`);
      })();
      await bounded(receive, 90_000, `Hermes ${profile} run`);
      assert.ok(server.hits.length > before, `Hermes ${profile} must call provider ${profile === 'bot1' ? 'A' : 'B'}`);
    }
    assert.ok(a.hits.length > 0 && b.hits.length > 0, 'both fake servers handled real Hermes runs');

    await http.x.models.roles.set({ role: 'coding', providerId: 'fake-b', model: 'fake-model' });
    const dshEnabled = await http.extensions.enable({ id: 'engine-dsh' });
    assert.equal(dshEnabled.status, 'running', dshEnabled.reason + ' ' + app.logs().slice(-1000));
    const dsh = await bounded(http.x['engine-dsh'].create({
      workspaceId: 'models-e2e', cwd: temp, role: 'coding',
    }), 60_000, 'DSH session create');
    const dshHits = b.hits.length;
    try {
      await bounded(http.x['engine-dsh'].prompt({ sessionId: dsh.sessionId, text: 'Confirm coding model B.' }),
        60_000, 'DSH prompt');
      await bounded(http.x['engine-dsh'].wait({ sessionId: dsh.sessionId }), 60_000, 'DSH wait');
      assert.ok(b.hits.length > dshHits, 'DSH coding role must call fake provider B');
    } finally {
      await http.x['engine-dsh'].shutdown({ sessionId: dsh.sessionId });
    }

    assert.equal((await http.extensions.disable({ id: 'models' })).status, 'disabled');
    assert.equal((await http.extensions.list()).find((item) => item.id === 'engine-hermes')?.status, 'running');
    assert.deepEqual(await (await fetch(base + '/x/sample-ts/hello', { headers: auth })).json(),
      { message: 'Hello from TypeScript' });
    assert.equal((await fetch(base + '/x/models/providers/list', { headers: auth })).status, 404);
    assert.ok(!app.logs().includes(keyA) && !app.logs().includes(keyB), 'keys leaked in gateway logs');
    console.log('MODELS_E2E PASS authenticated=true bot1=A bot2=B dsh-coding=B keys=vault logs=clean disable=models-only others=healthy');
  } finally {
    socket?.close();
    if (app?.child.connected) app.child.send('shutdown');
    if (app?.child && app.child.exitCode === null) {
      await bounded(new Promise<void>((done) => app!.child.once('exit', () => done())), 15_000, 'gateway shutdown')
        .catch(() => app!.child.kill('SIGKILL'));
    }
    for (const fake of [a, b]) {
      fake.server.closeAllConnections();
      await new Promise<void>((done) => fake.server.close(() => done()));
    }
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

await main();
