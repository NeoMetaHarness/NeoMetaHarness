import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { WebSocket } from 'ws';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type HermesEvent } from '@neometaharness/contracts';
import { coalesceText } from '../../../apps/gateway/src/coalesce.js';

const extension = fileURLToPath(new URL('../', import.meta.url));
const repo = resolve(extension, '../..');
const gatewayDir = join(repo, 'apps/gateway');
type Client = ContractRouterClient<typeof neoContract>;

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

async function fakeModel(): Promise<{ server: Server; port: number }> {
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
        stream?: boolean; messages?: { role: string; content?: unknown }[];
      };
      const messages = input.messages ?? [];
      const user = [...messages].reverse().find((m) => m.role === 'user');
      const userText = String(user?.content ?? '');
      const toolDone = messages.some((m) => m.role === 'tool');
      const approval = userText.includes('trigger_approval') && !toolDone;
      const slow = userText.includes('trigger_stop') && !toolDone;
      const command = { command: 'rm -rf /tmp/danger_zone' };
      const tool = {
        id: 'call_approval', type: 'function',
        function: { name: 'terminal', arguments: JSON.stringify(command) },
      };
      const message = approval
        ? { role: 'assistant', content: 'Requesting permission', tool_calls: [tool] }
        : { role: 'assistant', content: toolDone ? 'Permission declined. Run complete.' : 'Hermes fake answer complete.' };
      if (!input.stream) {
        if (slow) await new Promise((done) => setTimeout(done, 20000));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'fake-completion', object: 'chat.completion', model: 'fake-model',
          choices: [{ index: 0, message, finish_reason: approval ? 'tool_calls' : 'stop' }],
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (delta: object, finish_reason: string | null = null) => {
        const chunk = { id: 'fake-completion', object: 'chat.completion.chunk',
          created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason }] };
        if (!res.destroyed) res.write('data: ' + JSON.stringify(chunk) + '\n\n');
      };
      send({ role: 'assistant', content: '' });
      if (slow) {
        send({ content: 'Starting long task. ' });
        await new Promise((done) => setTimeout(done, 20000));
      } else if (approval) {
        send({ content: 'Hello ' });
        send({ content: 'from ' });
        send({ content: 'Hermes.' });
        send({ tool_calls: [{ index: 0, ...tool }] });
      } else {
        for (const piece of ['Permission ', 'declined. ', 'Run complete.']) send({ content: piece });
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
  return { server, port: address.port };
}

function processRows(): { pid: number; parent: number; name: string }[] {
  if (process.platform !== 'win32') {
    const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
      .trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/))
      .map(([pid, parent, name]) => ({ pid: Number(pid), parent: Number(parent), name }));
    return rows;
  }
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'],
  { encoding: 'utf8', timeout: 20000, maxBuffer: 4_000_000 });
  const parsed = JSON.parse(output) as { ProcessId: number; ParentProcessId: number; Name: string }[];
  const rows = [parsed].flat().map((p) => ({ pid: p.ProcessId, parent: p.ParentProcessId, name: p.Name }));
  return rows;
}

function pidTree(rootPid: number) {
  return childrenOf(rootPid, processRows());
}

function childrenOf(rootPid: number, rows: { pid: number; parent: number; name: string }[]) {
  const found = new Set([rootPid]);
  let size = 0;
  while (found.size > size) {
    size = found.size;
    for (const row of rows) if (found.has(row.parent)) found.add(row.pid);
  }
  return rows.filter((row) => row.pid !== rootPid && found.has(row.pid));
}

async function gateway(home: string, modelUrl: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: gatewayDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NMH_HERMES_HOME: home, NMH_HERMES_MODEL_URL: modelUrl,
      NMH_DB_PATH: join(home, 'neo.sqlite'), NMH_EXTENSIONS_DIR: join(repo, 'extensions'),
      NMH_PORT: '0', NEO_MODE: 'desktop', NEO_PRINT_DESKTOP_TOKEN: '1' },
  });
  let stderr = '';
  child.stderr!.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-6000); });
  let token = '';
  const port = await bounded(new Promise<number>((done, reject) => {
    const reader = createInterface({ input: child.stdout! });
    reader.on('line', (line) => {
      if (line.startsWith('NEO_DESKTOP_TOKEN ')) token = line.slice('NEO_DESKTOP_TOKEN '.length).trim();
      if (line.startsWith('GATEWAY_READY ')) {
        reader.close();
        done((JSON.parse(line.slice(14)) as { port: number }).port);
      }
    });
    child.once('exit', (code) => reject(new Error('Gateway exited ' + code + ' ' + stderr)));
    child.once('error', reject);
  }), 25000, 'Gateway startup');
  return { child, port, token, get error() { return stderr; } };
}

async function closeGateway(child?: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null) return;
  if (child.connected) child.send('shutdown');
  try {
    await bounded(new Promise<void>((done) => child.once('exit', () => done())), 12000, 'gateway shutdown');
  } catch {
    child.kill('SIGKILL');
  }
}

async function main() {
  const batches = await Array.fromAsync(coalesceText((async function* (): AsyncGenerator<HermesEvent> {
    yield { kind: 'text.delta', sequence: 1, messageId: 'run', textDelta: 'a' };
    yield { kind: 'text.delta', sequence: 2, messageId: 'run', textDelta: 'b' };
    yield { kind: 'event', sequence: 3, type: 'approval.request' };
    yield { kind: 'text.delta', sequence: 4, messageId: 'run', textDelta: 'c' };
  })(), 33));
  assert.deepEqual(batches.map((event) => [event.sequence, event.textDelta, event.coalescedCount]),
    [[2, 'ab', 2], [3, undefined, undefined], [4, 'c', 1]]);

  const temp = await mkdtemp(join(tmpdir(), 'nmh-hermes-isolated-'));
  const home = join(temp, 'hermes-home');
  let app: Awaited<ReturnType<typeof gateway>> | undefined;
  let socket: WebSocket | undefined;
  const model = await fakeModel();
  try {
    app = await gateway(home, 'http://127.0.0.1:' + model.port + '/v1');
    const token = app.token;
    const base = 'http://127.0.0.1:' + app.port;
    const http = createORPCClient<Client>(new HttpLink({ url: base, headers: () => ({ authorization: `Bearer ${token}` }) }));
    socket = new WebSocket('ws://127.0.0.1:' + app.port + '/ws', ['bearer.' + token]);
    const ws = createORPCClient<Client>(new WebSocketLink({ websocket: socket }));
    assert.equal((await http.extensions.enable({ id: 'sample-ts' })).status, 'running');
    const enabled = await http.extensions.enable({ id: 'engine-hermes' });
    assert.equal(enabled.status, 'running', app.error + '\n' + enabled.reason);
    const info = (await http.extensions.list()).find((item) => item.id === 'engine-hermes');
    assert.equal(info?.status, 'running');

    const created = await http.x['engine-hermes'].profiles.create({ name: 'neo_test' });
    assert.equal(created.name, 'neo_test');
    assert.ok((await http.x['engine-hermes'].profiles.list()).profiles.some((p) => p.name === 'neo_test'));
    const key = (await readFile(join(home, 'profiles/neo_test/.env'), 'utf8'))
      .match(/^API_SERVER_KEY=(\w+)/m)?.[1];
    assert.ok(key && key.length >= 16, 'per-profile API key must be minted');

    const run = await http.x['engine-hermes'].runs.start({
      profile: 'neo_test', input: 'trigger_approval clean temp directory',
    });
    assert.ok(run.run_id);
    const streamEvents: HermesEvent[] = [];
    let denied = false;
    for await (const event of await ws.x['engine-hermes'].runs.events({
      profile: 'neo_test', runId: run.run_id,
    })) {
      streamEvents.push(event);
      if (event.type === 'approval.request' && !denied) {
        assert.equal((await http.x['engine-hermes'].runs.approve({
          profile: 'neo_test', runId: run.run_id, choice: 'deny',
        })).ok, true);
        denied = true;
      }
      if (event.type === 'run.completed') break;
    }
    assert.ok(denied, 'Hermes must request permission for the terminal tool');
    assert.ok(streamEvents.some((event) => event.type === 'run.completed'), 'run must complete after denial');
    const text = streamEvents.filter((event) => event.kind === 'text.delta').map((e) => e.textDelta).join('');
    assert.match(text, /Hello|Permission|Hermes/);
    const sequence = streamEvents.map((event) => event.sequence!);
    assert.ok(sequence.every((s, i) => i === 0 || s > sequence[i - 1]), 'stream order');
    assert.ok(streamEvents.some((e) => e.kind === 'text.delta' && (e.coalescedCount ?? 0) >= 2),
      'gateway must coalesce adjacent text fragments');

    const stoppedRun = await http.x['engine-hermes'].runs.start({
      profile: 'neo_test', input: 'trigger_stop slow model answer',
    });
    const stopped = await http.x['engine-hermes'].runs.stop({
      profile: 'neo_test', runId: stoppedRun.run_id,
    });
    assert.ok(['cancelled', 'interrupted'].includes(stopped.status), 'stop must reach a cancelled terminal state');

    const cron = await http.x['engine-hermes'].cron.create({
      prompt: 'test job', schedule: '0 0 * * *',
    });
    assert.ok(cron.id);
    assert.ok((await http.x['engine-hermes'].cron.list()).some((job) => job.id === cron.id));
    await http.x['engine-hermes'].cron.delete({ id: cron.id });
    assert.ok(!(await http.x['engine-hermes'].cron.list()).some((job) => job.id === cron.id));

    await http.x['engine-hermes'].profiles.create({ name: 'removal_test' });
    await http.x['engine-hermes'].profiles.delete({ name: 'removal_test' });
    assert.ok(!(await http.x['engine-hermes'].profiles.list()).profiles.some((p) => p.name === 'removal_test'));

    const descendants = pidTree(app.child.pid!);
    const python = descendants.filter((proc) => /python/i.test(proc.name));
    assert.ok(python.length >= 2, 'Hermes dashboard and API Python processes must be alive');
    await http.extensions.disable({ id: 'engine-hermes' });
    let remaining = python;
    for (let i = 0; i < 35; i++) {
      const alive = new Set(processRows().map((entry) => entry.pid));
      remaining = python.filter((proc) => alive.has(proc.pid));
      if (!remaining.length) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.deepEqual(remaining, [], 'disabling Hermes must terminate Python processes');
    const disabled = await fetch(base + '/x/engine-hermes/profiles/list', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(disabled.status, 404, 'Hermes routes must be removed');
    assert.deepEqual(await (await fetch(base + '/x/sample-ts/hello', { headers: { authorization: `Bearer ${token}` } })).json(),
      { message: 'Hello from TypeScript' });
    await http.x['engine-hermes'].profiles.list().then(
      () => assert.fail('Hermes contract must reject requests after disable'),
      () => {},
    );
    console.log('HERMES_GATEWAY_E2E PASS profiles=true streamed=' + streamEvents.length +
      ' coalesced=true deny=completed stop=' + stopped.status + ' cron=true processes=gone routes=404 sample=healthy');
  } catch (error) {
    console.error('HERMES_E2E_ERROR', error, app?.error);
    throw error;
  } finally {
    socket?.close();
    await closeGateway(app?.child);
    model.server.closeAllConnections();
    await new Promise<void>((done) => model.server.close(() => done()));
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

await main();
