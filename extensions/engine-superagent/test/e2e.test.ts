import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { WebSocket } from 'ws';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type InboxEvent, type InboxItem } from '@neometaharness/contracts';

type Client = ContractRouterClient<typeof neoContract>;
const root = resolve(import.meta.dirname, '../../..');
function upstreamCache(): string {
  if (process.env.NMH_UPSTREAM_CACHE) return process.env.NMH_UPSTREAM_CACHE;
  for (let parent = root; ; parent = dirname(parent)) {
    const path = join(parent, 'nmh-upstream-cache');
    if (existsSync(path)) return path;
    if (dirname(parent) === parent) throw new Error('Set NMH_UPSTREAM_CACHE to the pinned upstream source cache');
  }
}

async function bounded<T>(promise: Promise<T>, name: string, ms = 60000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name} timed out`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function until(check: () => Promise<boolean>, name: string, ms = 60000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`${name} timed out`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

async function fakeHermesModel(): Promise<{
  server: Server; port: number; seen: string[]; release(): void;
}> {
  const seen: string[] = [];
  let release = () => {};
  const barrier = new Promise<void>((done) => { release = done; });
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
      return;
    }
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        stream?: boolean; messages?: { role: string; content?: unknown }[];
      };
      const prompt = String([...body.messages ?? []].reverse().find((message) => message.role === 'user')?.content ?? '');
      seen.push(prompt);
      if (prompt.includes('hold_for_disable')) await barrier;
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', model: 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hermes fake answer complete.' },
            finish_reason: 'stop' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const chunk = (delta: object, finish_reason: string | null) => ({
        id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model',
        choices: [{ index: 0, delta, finish_reason }],
      });
      res.write('data: ' + JSON.stringify(chunk({ role: 'assistant', content: 'Hermes fake answer complete.' }, null)) + '\n\n');
      res.end('data: ' + JSON.stringify(chunk({}, 'stop')) + '\n\ndata: [DONE]\n\n');
    } catch (error) { if (!res.destroyed) res.writeHead(500).end(String(error)); }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  return { server, port: addr.port, seen, release };
}

async function fakeDshModel(): Promise<{
  server: Server; port: number; seen: { stage: number; tool: string; tools: string[]; args: { botId: string; text: string } }[];
  evals: { botId: string; text: string; mode: string; evalId: string }[];
}> {
  const seen: { stage: number; tool: string; tools: string[]; args: { botId: string; text: string } }[] = [];
  const evals: { botId: string; text: string; mode: string; evalId: string }[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !['/evaluate', '/generate'].includes(req.url ?? '')) {
      res.writeHead(404).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      if (req.url === '/evaluate') {
        const { prompt } = JSON.parse(Buffer.concat(chunks).toString()) as { prompt: { type: string; text: string }[] };
        const request = JSON.parse(prompt.find((part) => part.type === 'text')!.text) as typeof evals[number];
        assert.ok(request.evalId && request.botId && request.text);
        assert.ok(request.mode === 'observe' || request.mode === 'act');
        evals.push(request);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ decision: 'accept' }));
        return;
      }
      const request = JSON.parse(Buffer.concat(chunks).toString()) as typeof seen[number];
      assert.ok(request.tools.includes(request.tool), 'DSH worker MCP tool must be available to the model');
      assert.match(request.tool, /^mcp__neo__agents_send_to_bot_[a-f0-9]+$/);
      assert.ok(request.args.botId && request.args.text);
      assert.ok(request.stage === 1 || request.stage === 2);
      seen.push(request);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ action: request.stage === 1 ? 'delegate' : 'finish' }));
    } catch (error) { res.writeHead(500).end(String(error)); }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  return { server, port: addr.port, seen, evals };
}

async function gateway(home: string, modelPort: number, dshModelPort: number): Promise<{
  child: ChildProcess; port: number; token: string; get stderr(): string;
}> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: join(root, 'apps/gateway'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NMH_UPSTREAM_CACHE: upstreamCache(), NMH_HERMES_HOME: join(home, 'hermes'),
      NMH_HERMES_MODEL_URL: `http://127.0.0.1:${modelPort}/v1`,
      NMH_SUPERAGENT_MODEL_URL: `http://127.0.0.1:${dshModelPort}`,
      NMH_DB_PATH: join(home, 'db.sqlite'), NMH_EXTENSIONS_DIR: join(root, 'extensions'), NMH_PORT: '0',
      NEO_MODE: 'desktop', NEO_PRINT_DESKTOP_TOKEN: '1' },
  });
  let stderr = '';
  child.stderr!.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-8000); });
  let token = '';
  const port = await bounded(new Promise<number>((done, reject) => {
    const reader = createInterface({ input: child.stdout! });
    reader.on('line', (line) => {
      if (line.startsWith('NEO_DESKTOP_TOKEN ')) token = line.slice(18).trim();
      if (!line.startsWith('GATEWAY_READY ')) return;
      reader.close();
      const payload = JSON.parse(line.slice(14)) as { port: number; token?: string };
      if (payload.token) token = payload.token;
      done(payload.port);
    });
    child.once('exit', (code) => reject(new Error(`Gateway exited ${code}: ${stderr}`)));
    child.once('error', reject);
  }), 'Gateway boot', 45000);
  return { child, port, token, get stderr() { return stderr; } };
}

async function close(child?: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null) return;
  if (child.connected) child.send('shutdown');
  try { await bounded(new Promise<void>((done) => child.once('exit', () => done())), 'Gateway shutdown', 25000); }
  catch { child.kill('SIGKILL'); }
}

async function main() {
  const home = await mkdtemp(join(tmpdir(), 'nmh-superagent-'));
  const model = await fakeHermesModel();
  const dshModel = await fakeDshModel();
  let app: Awaited<ReturnType<typeof gateway>> | undefined;
  let ws: WebSocket | undefined;
  try {
    app = await gateway(home, model.port, dshModel.port);
    const client = createORPCClient<Client>(new HttpLink({
      url: `http://127.0.0.1:${app.port}`,
      headers: { authorization: `Bearer ${app.token}` },
    }));
    ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, ['bearer.' + app.token]);
    const live = createORPCClient<Client>(new WebSocketLink({ websocket: ws }));
    const hermes = await client.extensions.enable({ id: 'engine-hermes' });
    assert.equal(hermes.status, 'running', hermes.reason ?? app.stderr);
    const superagent = await client.extensions.enable({ id: 'engine-superagent' });
    assert.equal(superagent.status, 'running', superagent.reason ?? app.stderr);
    const bot = await client.agents.bots.create({ name: 'Delegated Hermes' });
    const observed = await client.inbox.ask({ text: 'Explain our task', botId: bot.id });
    assert.equal(observed.mode, 'observe', 'Ask Neo defaults to human-reviewed observe mode');
    assert.equal(observed.status, 'suggestion');
    assert.equal((await client.inbox.list()).find((entry) => entry.id === observed.id)?.status, 'suggestion');
    assert.equal((await client.agents.turns.list({ botId: bot.id })).length, 0);
    const received: InboxEvent[] = [];
    const abort = new AbortController();
    const listening = (async () => {
      for await (const event of await live.inbox.events({ since: 0 }, { signal: abort.signal })) {
        received.push(event);
        if (event.item.id === observed.id && event.item.status === 'ready') break;
      }
    })();
    await client.inbox.accept({ id: observed.id });
    await bounded(listening, 'Live inbox events', 22000).catch(async (error) => {
      throw new Error(`${String(error)} items=${JSON.stringify(await client.inbox.list())} events=${JSON.stringify(received)} model=${JSON.stringify(model.seen)}`);
    });
    assert.ok(received.some((event) => event.item.id === observed.id && event.item.status === 'suggestion'));
    assert.ok(received.some((event) => event.item.id === observed.id && event.item.status === 'running'));
    assert.ok(received.every((event, index) => index === 0 || received[index - 1]!.seq < event.seq));
    const report = (await client.inbox.list()).find((item) => item.id === observed.id)?.report;
    assert.equal(report?.status, 'ready');
    assert.equal(report.summary, 'Hermes fake answer complete.');
    assert.deepEqual(report.tests, []);
    assert.deepEqual(report.risks, []);

    const acted = await client.inbox.ask({ text: 'Act directly', botId: bot.id, mode: 'act' });
    await until(async () => (await client.inbox.list()).some((item) => item.id === acted.id && item.status === 'ready'), 'Act ticket');
    assert.equal((await client.inbox.list()).find((item) => item.id === acted.id)?.report?.status, 'ready');

    const blocked = await client.inbox.ask({ text: 'hold_for_disable', botId: bot.id, mode: 'act' });
    await until(async () => model.seen.some((prompt) => prompt.includes('hold_for_disable')), 'Hermes mid-flight', 75000);
    await bounded(client.extensions.disable({ id: 'engine-hermes' }), 'Disable Hermes', 60000);
    model.release();
    await until(async () => (await client.inbox.list()).some((item) => item.id === blocked.id && item.status === 'blocked'), 'Blocked ticket', 15000).catch(async (error) => {
      throw new Error(`${String(error)} items=${JSON.stringify(await client.inbox.list())} turns=${JSON.stringify(await client.agents.turns.list({botId: bot.id}).catch(e=>String(e)))} model=${JSON.stringify(model.seen)}`);
    });
    const blockedReport = (await client.inbox.list()).find((item) => item.id === blocked.id)?.report;
    assert.equal(blockedReport?.status, 'blocked');
    assert.match(blockedReport.summary, /disabled|unavailable|interrupted|stopped|unknown|requires? an enabled/i);
    assert.ok(blockedReport.risks.length > 0);
    assert.equal(dshModel.seen.filter((request) => request.stage === 1).length, 3);
    assert.equal(dshModel.seen.filter((request) => request.stage === 2).length, 3);
    assert.equal(dshModel.seen.filter((request) => request.args.text === 'Explain our task').length, 2);
    assert.equal(dshModel.seen.filter((request) => request.args.text === 'Act directly').length, 2);
    assert.equal(dshModel.seen.filter((request) => request.args.text === 'hold_for_disable').length, 2);
    assert.equal(dshModel.evals.length, 3);
    assert.deepEqual(dshModel.evals.map((request) => request.mode), ['observe', 'act', 'act']);
    abort.abort();
    console.log(`SUPERAGENT_E2E PASS observe=ready act=ready midflight=blocked streamed_events=${received.length} hermes_requests=${model.seen.length} dsh_eval_requests=${dshModel.evals.length} dsh_worker_requests=${dshModel.seen.length}`);
  } catch (error) {
    model.release();
    console.error('SUPERAGENT_E2E_ERROR', error, app?.stderr);
    throw error;
  } finally {
    ws?.close();
    model.release();
    await close(app?.child);
    model.server.closeAllConnections();
    await new Promise<void>((done) => model.server.close(() => done()));
    dshModel.server.closeAllConnections();
    await new Promise<void>((done) => dshModel.server.close(() => done()));
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

await main();
