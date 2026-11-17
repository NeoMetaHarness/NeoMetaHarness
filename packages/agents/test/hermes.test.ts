import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { WebSocket } from 'ws';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';

type Client = ContractRouterClient<typeof neoContract>;
const repo = resolve(import.meta.dirname, '../../..');
const gatewayDir = join(repo, 'apps/gateway');

async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), ms);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function until(check: () => Promise<boolean> | boolean, label: string, ms = 30000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(label + ' timed out');
    await new Promise((done) => setTimeout(done, 70));
  }
}

async function fakeModel(): Promise<{
  server: Server;
  port: number;
  started: string[];
  release: () => void;
}> {
  const started: string[] = [];
  let release = () => {};
  const barrier = new Promise<void>((done) => { release = done; });
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
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
      const input = JSON.parse(Buffer.concat(chunks).toString()) as {
        stream?: boolean;
        messages?: { role: string; content?: unknown }[];
      };
      const messages = input.messages ?? [];
      const user = [...messages].reverse().find((message) => message.role === 'user');
      const prompt = String(user?.content ?? '');
      const toolDone = messages.some((message) => message.role === 'tool');
      const approval = prompt.includes('trigger_approval') && !toolDone;
      const hold = prompt.includes('hold_alpha_1') || prompt.includes('hold_beta_1');
      started.push(prompt);
      if (hold) await barrier;
      const tool = { id: 'call_approval', type: 'function',
        function: { name: 'terminal', arguments: JSON.stringify({ command: 'rm -rf /tmp/danger_zone' }) } };
      const final = approval
        ? { role: 'assistant', content: 'Requesting permission', tool_calls: [tool] }
        : { role: 'assistant', content: toolDone ? 'Permission declined. Run complete.' : 'Hermes fake answer complete.' };
      if (!input.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'fake-completion', object: 'chat.completion', model: 'fake-model',
          choices: [{ index: 0, message: final, finish_reason: approval ? 'tool_calls' : 'stop' }],
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (delta: object, finish_reason: string | null = null) => {
        const chunk = { id: 'fake-completion', object: 'chat.completion.chunk', created: 1,
          model: 'fake-model', choices: [{ index: 0, delta, finish_reason }] };
        if (!res.destroyed) res.write('data: ' + JSON.stringify(chunk) + '\n\n');
      };
      send({ role: 'assistant', content: '' });
      if (approval) {
        send({ content: 'Approval ' });
        send({ content: 'needed.' });
        send({ tool_calls: [{ index: 0, ...tool }] });
      } else {
        for (const piece of ['Hermes ', 'fake ', 'answer.']) send({ content: piece });
      }
      send({}, approval ? 'tool_calls' : 'stop');
      if (!res.destroyed) res.end('data: [DONE]\n\n');
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, port: address.port, started, release };
}

async function launchGateway(home: string, modelPort: number) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: gatewayDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NMH_HERMES_HOME: join(home, 'hermes'),
      NMH_HERMES_MODEL_URL: `http://127.0.0.1:${modelPort}/v1`,
      NMH_DB_PATH: join(home, 'neo.sqlite'), NMH_EXTENSIONS_DIR: join(repo, 'extensions'),
      NMH_PORT: '0' },
  });
  let stderr = '';
  child.stderr!.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-6000); });
  const port = await bounded(new Promise<number>((done, reject) => {
    const reader = createInterface({ input: child.stdout! });
    reader.on('line', (line) => {
      if (!line.startsWith('GATEWAY_READY ')) return;
      reader.close();
      done((JSON.parse(line.slice(14)) as { port: number }).port);
    });
    child.once('exit', (code) => reject(new Error(`Gateway exited ${code}: ${stderr}`)));
    child.once('error', reject);
  }), 30000, 'Gateway startup');
  return { child, port, get error() { return stderr; } };
}

async function closeGateway(child?: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null) return;
  if (child.connected) child.send('shutdown');
  try {
    await bounded(new Promise<void>((done) => child.once('exit', () => done())), 20000, 'Gateway shutdown');
  } catch {
    child.kill('SIGKILL');
  }
}

async function main(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'nmh-agents-hermes-'));
  const model = await fakeModel();
  let app: Awaited<ReturnType<typeof launchGateway>> | undefined;
  let socket: WebSocket | undefined;
  try {
    app = await launchGateway(home, model.port);
    const client = createORPCClient<Client>(new HttpLink({ url: `http://127.0.0.1:${app.port}` }));
    socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    const streaming = createORPCClient<Client>(new WebSocketLink({ websocket: socket }));
    const extension = await bounded(client.extensions.enable({ id: 'engine-hermes' }), 100000, 'Enable Hermes');
    assert.equal(extension.status, 'running', app.error + '\n' + extension.reason);

    const alpha = await client.agents.bots.create({ name: 'Alpha' });
    const beta = await client.agents.bots.create({ name: 'Beta' });
    assert.equal((await client.agents.bots.list()).length, 2);
    const first = await client.agents.turns.send({ botId: alpha.id, text: 'hold_alpha_1' });
    const queued = await client.agents.turns.send({ botId: alpha.id, text: 'alpha_2' });
    const parallel = await client.agents.turns.send({ botId: beta.id, text: 'hold_beta_1' });
    await until(() => model.started.some((text) => text.includes('hold_alpha_1')) &&
      model.started.some((text) => text.includes('hold_beta_1')), 'Parallel starts', 80000);
    assert.equal((await client.agents.turns.list({ botId: alpha.id }))
      .find((turn) => turn.id === queued.turnId)?.status, 'queued');
    assert.ok(!model.started.some((text) => text.includes('alpha_2')), 'Second Alpha is serialized');
    model.release();

    const events = await bounded((async () => {
      const values = [];
      for await (const event of await streaming.agents.turns.events({ turnId: first.turnId })) {
        values.push(event);
        if (event.type === 'turn.status' &&
          (event.payload as { status?: string })?.status === 'completed') break;
      }
      return values;
    })(), 60000, 'Turn event stream');
    assert.ok(events.some((event) => event.kind === 'text.delta' && event.messageId === first.turnId));
    assert.ok(events.some((event) => event.type === 'turn.status'));
    await until(async () => (await client.agents.turns.list({ botId: alpha.id }))
      .find((turn) => turn.id === queued.turnId)?.status === 'completed', 'Serialized second Alpha');
    await until(async () => (await client.agents.turns.list({ botId: beta.id }))
      .find((turn) => turn.id === parallel.turnId)?.status === 'completed', 'Parallel Beta');

    const denied = await client.agents.turns.send({ botId: alpha.id, text: 'trigger_approval' });
    let requestId = '';
    await until(async () => {
      const approvals = await client.agents.approvals.list({ turnId: denied.turnId });
      requestId = approvals.find((approval) => approval.status === 'pending')?.id ?? '';
      return requestId.length > 0;
    }, 'Hermes approval', 60000);
    assert.equal((await client.agents.approvals.resolve({ id: requestId, decision: 'deny' })).resolved, true);
    await until(async () => (await client.agents.turns.list({ botId: alpha.id }))
      .find((turn) => turn.id === denied.turnId)?.status === 'denied', 'Approval denial');

    const room = await client.agents.rooms.create({ name: 'Team', memberIds: [alpha.id, beta.id] });
    const fanout = await client.agents.rooms.post({ roomId: room.id, text: 'Room sync' });
    assert.equal(fanout.turnIds.length, 2);
    await until(async () => {
      const turns = await Promise.all([client.agents.turns.list({ botId: alpha.id }),
        client.agents.turns.list({ botId: beta.id })]);
      return turns.flat().filter((turn) => fanout.turnIds.includes(turn.id) && turn.status === 'completed').length === 2;
    }, 'Room fanout', 60000);

    const task = await client.agents.tasks.create({ botId: alpha.id, title: 'Review' });
    assert.equal((await client.agents.tasks.update({ id: task.id, status: 'done' })).updated, true);
    const routine = await client.agents.routines.create({
      botId: beta.id, name: 'Check-in', prompt: 'Summarize daily updates',
      schedule: '0 9 * * *', timezone: 'UTC',
    });
    const cron = await client.x['engine-hermes'].cron.list();
    assert.ok(cron.some((job) => String(job.prompt ?? '').includes(routine.id)), 'Hermes cron registered');
    assert.ok(cron.some((job) => String(job.prompt ?? '').includes('Summarize daily updates')),
      'Hermes cron carries the routine prompt');

    await client.extensions.disable({ id: 'engine-hermes' });
    await assert.rejects(client.agents.bots.list(), (error: { status?: number }) => error.status === 503);
    assert.equal((await client.extensions.enable({ id: 'engine-hermes' })).status, 'running');
    assert.equal((await client.agents.bots.list()).length, 2);
    const restored = await client.agents.turns.send({ botId: beta.id, text: 'Works again' });
    await until(async () => (await client.agents.turns.list({ botId: beta.id }))
      .find((turn) => turn.id === restored.turnId)?.status === 'completed', 'Run after reenable', 60000);

    console.log('AGENTS_HERMES_E2E PASS bots=2 serial=true parallel=true events=' + events.length +
      ' approval=denied room=2 task=done cron=true disabled=503 reenabled=true');
  } catch (error) {
    model.release();
    console.error('AGENTS_HERMES_E2E_ERROR', error, app?.error);
    throw error;
  } finally {
    socket?.close();
    await closeGateway(app?.child);
    model.server.closeAllConnections();
    await new Promise<void>((done) => model.server.close(() => done()));
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

await main();
