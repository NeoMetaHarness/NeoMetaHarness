import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import { WebSocket } from 'ws';
import { neoContract, type HermesEvent } from '@neometaharness/contracts';
import { startGateway } from '../../../apps/gateway/src/server.js';
import { FakeComputerProvider } from '../../../extensions/computer-fake/src/index.js';
import { ComputerRegistry } from '../src/index.js';
import { projectHermesComputer } from '../src/hermes.js';

type Client = ContractRouterClient<typeof neoContract>;
const extensions = fileURLToPath(new URL('../../../extensions/', import.meta.url));

async function bounded<T>(work: Promise<T>, label: string, ms = 120_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function scriptedHermesModel(): Promise<{ server: Server; port: number }> {
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
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      stream?: boolean;
      messages?: { role: string; content: unknown }[];
    };
    const messages = input.messages ?? [];
    const toolDone = messages.some((message) => message.role === 'tool');
    const useComputer = messages.some((message) => message.role === 'user' &&
      JSON.stringify(message.content).includes('trigger_neo_computer')) && !toolDone &&
      !messages.some((message) => message.role === 'system' &&
        JSON.stringify(message.content).includes('You name chat sessions'));
    const tool = {
      id: 'neo-computer-hermes', type: 'function',
      function: { name: 'tool_call', arguments: JSON.stringify({ calls: [{
        name: 'computer_use', arguments: { action: 'click', coordinate: [100, 200], capture_after: true },
      }] }) },
    };
    const message = useComputer
      ? { role: 'assistant', content: 'Using the assigned computer', tool_calls: [tool] }
      : { role: 'assistant', content: 'Neo computer run complete.' };
    if (!input.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'neo-model', object: 'chat.completion', model: 'fake-model',
        choices: [{ index: 0, message, finish_reason: useComputer ? 'tool_calls' : 'stop' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta: object, finish_reason: string | null = null) => {
      res.write('data: ' + JSON.stringify({
        id: 'neo-model', object: 'chat.completion.chunk', created: 1, model: 'fake-model',
        choices: [{ index: 0, delta, finish_reason }],
      }) + '\n\n');
    };
    emit({ role: 'assistant', content: '' });
    if (useComputer) emit({ tool_calls: [{ index: 0, ...tool }] });
    else emit({ content: 'Neo computer run complete.' });
    emit({}, useComputer ? 'tool_calls' : 'stop');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, port: address.port };
}

async function main(): Promise<void> {
  const fakeForLifecycle = new FakeComputerProvider();
  const lifecycleRegistry = new ComputerRegistry(() => 'http://127.0.0.1/unused', () => {});
  const unregister = lifecycleRegistry.registerProvider('fake', fakeForLifecycle);
  await lifecycleRegistry.attach('fake', 'cleanup-check');
  assert.equal(fakeForLifecycle.computers.size, 1);
  await unregister();
  assert.equal(fakeForLifecycle.computers.size, 0, 'extension cleanup calls provider.release');
  assert.deepEqual(lifecycleRegistry.list(), []);

  const temp = await mkdtemp(join(tmpdir(), 'nmh-computers-'));
  const model = await scriptedHermesModel();
  const oldHome = process.env.NMH_HERMES_HOME;
  const oldModel = process.env.NMH_HERMES_MODEL_URL;
  const home = join(temp, 'hermes-home');
  process.env.NMH_HERMES_HOME = home;
  process.env.NMH_HERMES_MODEL_URL = `http://127.0.0.1:${model.port}/v1`;
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  let socket: WebSocket | undefined;
  try {
    gateway = await startGateway({ databaseFile: join(temp, 'neo.sqlite'), extensionsDir: extensions });
    const url = `http://127.0.0.1:${gateway.port}`;
    const http = createORPCClient<Client>(new HttpLink({ url }));
    socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`);
    const ws = createORPCClient<Client>(new WebSocketLink({ websocket: socket }));

    assert.equal((await http.extensions.enable({ id: 'sample-ts' })).status, 'running');
    assert.equal((await http.extensions.enable({ id: 'computer-fake' })).status, 'running');
    assert.equal((await http.computers.attach({ providerId: 'computer-fake', target: 'shared-screen' })).id, 'shared-screen');
    assert.equal((await http.extensions.enable({ id: 'engine-hermes' })).status, 'running');
    const dshStatus = await http.extensions.enable({ id: 'engine-dsh' });
    assert.equal(dshStatus.status, 'running', JSON.stringify(dshStatus));

    await http.x['engine-hermes'].profiles.create({ name: 'computer_test' });
    await http.computers.assign({ engine: 'hermes', targetId: 'computer_test', computerId: 'shared-screen' });
    const run = await http.x['engine-hermes'].runs.start({ profile: 'computer_test', input: 'trigger_neo_computer' });
    const hermesEvents: HermesEvent[] = [];
    await bounded((async () => {
      for await (const event of await ws.x['engine-hermes'].runs.events({ profile: 'computer_test', runId: run.run_id })) {
        hermesEvents.push(event);
        if (event.type === 'approval.request') {
          await http.x['engine-hermes'].runs.approve({ profile: 'computer_test', runId: run.run_id, choice: 'once' });
        }
      }
    })(), 'Hermes model computer-use run');
    assert.ok(hermesEvents.some((event) => event.type === 'run.completed'),
      `Hermes failed: ${JSON.stringify(hermesEvents.slice(-10))}`);

    const dsh = await http.x['engine-dsh'].create({ workspaceId: 'computer-workspace', cwd: temp,
      computerId: 'shared-screen' });
    await http.x['engine-dsh'].prompt({ sessionId: dsh.sessionId, text: 'trigger_neo_computer' });
    assert.deepEqual(await bounded(http.x['engine-dsh'].wait({ sessionId: dsh.sessionId }), 'DSH computer run'),
      { status: 'settled' });

    const calls = await (await fetch(`${url}/x/computer-fake/calls`)).json() as { computerId: string; action: string }[];
    assert.deepEqual(calls.map((call) => call.action), ['click', 'capture', 'click', 'capture']);
    assert.ok(calls.every((call) => call.computerId === 'shared-screen'));
    const notices: { type: string; engine?: string; action?: string; active?: boolean }[] = [];
    const abort = new AbortController();
    await bounded((async () => {
      for await (const event of gateway!.kernel.events.subscribe(0, abort.signal)) {
        if (event.type === 'computer.acting') notices.push(event);
        if (notices.length === 8) { abort.abort(); break; }
      }
    })(), 'computer.acting events');
    assert.deepEqual(notices.filter((event) => event.active).map((event) => [event.engine, event.action]),
      [['hermes', 'click'], ['hermes', 'capture'], ['dsh', 'click'], ['dsh', 'capture']]);

    const hermesBinding = JSON.parse(await readFile(join(home, 'profiles/computer_test/plugins/neo_vnc/binding.json'), 'utf8')) as
      { endpoint: string; token: string; computerId: string };
    assert.equal(hermesBinding.computerId, 'shared-screen');
    const action = () => fetch(hermesBinding.endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${hermesBinding.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'click', x: 7, y: 9 }),
    });
    assert.deepEqual(await http.computers.kill({ engaged: true }), { engaged: true });
    assert.equal((await action()).status, 403, 'global kill switch blocks agent actions');
    await http.computers.kill({ engaged: false });
    await http.computers.lease({ id: 'shared-screen', holder: 'human' });
    assert.equal((await action()).status, 403, 'human lease blocks agent actions');
    await http.computers.lease({ id: 'shared-screen', holder: 'agent' });
    assert.equal((await action()).status, 200, 'agent can act following handback');
    gateway.computers.unassign('hermes', 'computer_test');
    assert.equal(await projectHermesComputer(gateway.computers, 'computer_test',
      join(home, 'profiles/computer_test')), undefined);
    await assert.rejects(readFile(join(home, 'profiles/computer_test/plugins/neo_vnc/binding.json'), 'utf8'),
      { code: 'ENOENT' }, 'unassigned Hermes profile has no live capability file');
    assert.equal((await action()).status, 403, 'unassignment revokes the former Hermes token');
    assert.equal((await http.extensions.disable({ id: 'computer-fake' })).status, 'disabled');
    assert.deepEqual(await http.computers.list(), [], 'provider disable detaches computers');
    assert.equal((await action()).status, 403, 'detached computer revokes capability');
    assert.deepEqual(await (await fetch(url + '/x/sample-ts/hello')).json(), { message: 'Hello from TypeScript' });
    await http.x['engine-dsh'].shutdown({ sessionId: dsh.sessionId });
    console.log('COMPUTERS_GATEWAY PASS hermes+DSH=one-computer ordered=4 events=8 kill=403 human=403 handback=200 disable=healthy');
  } finally {
    socket?.close();
    await gateway?.close();
    await new Promise<void>((resolve) => model.server.close(() => resolve()));
    if (oldHome === undefined) delete process.env.NMH_HERMES_HOME;
    else process.env.NMH_HERMES_HOME = oldHome;
    if (oldModel === undefined) delete process.env.NMH_HERMES_MODEL_URL;
    else process.env.NMH_HERMES_MODEL_URL = oldModel;
    await rm(temp, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
