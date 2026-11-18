import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';

const extension = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = resolve(extension, '../..');
const token = '123456:local-standin-token';
const rotated = '123456:rotated-standin-token';
const reply = 'Neo Telegram fake reply complete';
type Client = ContractRouterClient<typeof neoContract>;

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function eventually(test: () => Promise<boolean> | boolean, label: string, limit = 30000) {
  const deadline = Date.now() + limit;
  let last: unknown;
  while (Date.now() < deadline) {
    try { if (await test()) return; }
    catch (error) { last = error; }
    await pause(150);
  }
  throw new Error(`${label} timed out (${String(last ?? 'condition remained false')})`);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const value = Buffer.concat(chunks).toString('utf8');
  if (!value) return {};
  if ((req.headers['content-type'] ?? '').includes('application/json')) return JSON.parse(value) as Record<string, unknown>;
  if ((req.headers['content-type'] ?? '').includes('x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(value));
  return {};
}

function json(res: import('node:http').ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

function fakeTelegram() {
  const updates: { update_id: number; message: object }[] = [];
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let updateId = 1000;
  let messageId = 10;
  const bot = { id: 7000000001, is_bot: true, first_name: 'Hermes', username: 'hermes_standin_bot',
    can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false };
  const chat = { id: 111, type: 'private', first_name: 'Tester', username: 'user111' };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const match = /^\/bot([^/]+)\/([^/]+)$/.exec(path);
    if (!match || ![token, rotated].includes(match[1])) { json(res, { ok: false, error_code: 401, description: 'Unauthorized' }, 401); return; }
    const method = match[2];
    const params = await body(req);
    calls.push({ method, params });
    let result: unknown;
    if (method === 'getUpdates') {
      const offset = Number(params.offset ?? 0);
      const ready = updates.filter((update) => update.update_id >= offset);
      if (!ready.length) await pause(120);
      result = ready;
    } else if (method === 'getMe') result = bot;
    else if (method === 'getMyCommands') result = [];
    else if (method === 'getChat') result = { ...chat, accent_color_id: 0, max_reaction_count: 11 };
    else if (['sendMessage', 'editMessageText', 'sendRichMessage'].includes(method)) {
      result = { message_id: Number(params.message_id ?? ++messageId), date: Math.floor(Date.now() / 1000),
        chat, from: bot, text: String(params.text ?? '') };
    } else if (['sendMessageDraft', 'sendRichMessageDraft', 'setMyCommands', 'deleteMyCommands',
      'setMyDescription', 'setMyShortDescription', 'deleteWebhook', 'sendChatAction',
      'setMessageReaction', 'answerCallbackQuery', 'deleteMessage'].includes(method)) result = true;
    else { json(res, { ok: false, error_code: 404, description: 'Not Found' }, 404); return; }
    json(res, { ok: true, result });
  });
  return { server, calls, dm(text: string) {
    updates.push({ update_id: ++updateId, message: { message_id: ++messageId,
      date: Math.floor(Date.now() / 1000), chat,
      from: { id: 111, is_bot: false, first_name: 'Tester', username: 'user111', language_code: 'en' }, text } });
  } };
}

function fakeModel() {
  let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      json(res, { object: 'list', data: [{ id: 'fake-model', object: 'model' }] });
      return;
    }
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) { json(res, {}, 404); return; }
    const input = await body(req);
    calls++;
    if (!input.stream) {
      json(res, { id: 'fake-channel', object: 'chat.completion', model: 'fake-model',
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const delta of [{ role: 'assistant', content: '' }, { content: reply }, {}]) {
      res.write('data: ' + JSON.stringify({ id: 'fake-channel', object: 'chat.completion.chunk',
        created: 1, model: 'fake-model', choices: [{ index: 0, delta,
          finish_reason: Object.keys(delta).length ? null : 'stop' }] }) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  return { server, get calls() { return calls; } };
}

function processRows() {
  if (process.platform !== 'win32') {
    return execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
      .trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/))
      .map(([pid, parent, name]) => ({ pid: Number(pid), parent: Number(parent), name }));
  }
  const powershell = join(process.env.SystemRoot ?? 'C:/Windows', 'System32',
    'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const data = execFileSync(powershell, ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'],
  { encoding: 'utf8', timeout: 20000, maxBuffer: 4_000_000 });
  return [JSON.parse(data) as { ProcessId: number; ParentProcessId: number; Name: string }[]]
    .flat().map(({ ProcessId, ParentProcessId, Name }) =>
      ({ pid: ProcessId, parent: ParentProcessId, name: Name }));
}

function descendants(root: number) {
  const rows = processRows();
  const found = new Set([root]);
  let old = 0;
  while (old !== found.size) {
    old = found.size;
    for (const row of rows) if (found.has(row.parent)) found.add(row.pid);
  }
  return rows.filter((row) => row.pid !== root && found.has(row.pid));
}

async function gateway(home: string, modelUrl: string, telegramUrl: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: join(repo, 'apps/gateway'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NMH_HERMES_HOME: home, NMH_HERMES_MODEL_URL: modelUrl,
      NMH_CHANNELS_TELEGRAM_API_BASE: telegramUrl,
      NMH_DB_PATH: join(home, 'neo.sqlite'), NMH_EXTENSIONS_DIR: join(repo, 'extensions'), NMH_PORT: '0',
      NEO_MODE: 'desktop', NEO_PRINT_DESKTOP_TOKEN: '1' },
  });
  let stderr = '';
  child.stderr!.on('data', (data: Buffer) => {
    // Do not echo channel credentials even on a startup failure.
    stderr = (stderr + data.toString()).slice(-4000).replaceAll(token, '<redacted>').replaceAll(rotated, '<redacted>');
  });
  let desktopToken = '';
  const port = await Promise.race([new Promise<number>((done, reject) => {
    const reader = createInterface({ input: child.stdout! });
    reader.on('line', (line) => {
      if (line.startsWith('NEO_DESKTOP_TOKEN ')) desktopToken = line.slice('NEO_DESKTOP_TOKEN '.length).trim();
      if (line.startsWith('GATEWAY_READY ')) {
        const ready = JSON.parse(line.slice(14)) as { port: number; token?: string };
        desktopToken ||= ready.token ?? '';
        reader.close();
        done(ready.port);
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error('Gateway exited ' + code + ' ' + stderr)));
  }), pause(30000).then(() => { throw new Error('Gateway startup timeout ' + stderr); })]);
  assert.ok(desktopToken, 'gateway desktop token');
  return { child, port, desktopToken, get error() { return stderr; } };
}

async function closeGateway(child?: ChildProcess) {
  if (!child || child.exitCode !== null) return;
  if (child.connected) child.send('shutdown');
  await Promise.race([new Promise<void>((done) => child.once('exit', () => done())), pause(10000)]);
  if (child.exitCode === null) {
    if (process.platform === 'win32') execFileSync(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGKILL');
  }
}

async function main() {
  const temp = await mkdtemp(join(tmpdir(), 'nmh-channels-'));
  const home = join(temp, 'hermes');
  const telegram = fakeTelegram();
  const model = fakeModel();
  let app: Awaited<ReturnType<typeof gateway>> | undefined;
  try {
    const telegramPort = await listen(telegram.server);
    const modelPort = await listen(model.server);
    app = await gateway(home, 'http://127.0.0.1:' + modelPort + '/v1',
      'http://127.0.0.1:' + telegramPort + '/');
    const base = 'http://127.0.0.1:' + app.port;
    const headers = { authorization: `Bearer ${app.desktopToken}` };
    const rpc = createORPCClient<Client>(new RPCLink({ url: base, headers }));
    assert.equal((await rpc.extensions.enable({ id: 'sample-ts' })).status, 'running');
    assert.equal((await rpc.extensions.enable({ id: 'engine-hermes' })).status, 'running');
    await rpc.x['engine-hermes'].profiles.create({ name: 'telegramtest' });
    const enabled = await rpc.extensions.enable({ id: 'channels' });
    assert.equal(enabled.status, 'running', enabled.reason ?? app.error);
    const platforms = (await rpc.x.channels.list({ profile: 'telegramtest' })).platforms;
    assert.ok(platforms.length > 1 && platforms.some((p) => p.id === 'telegram'),
      'read dynamic platform list from Hermes');

    const envFile = join(home, 'profiles', 'telegramtest', '.env');
    await appendFile(envFile, '\n# LOCAL USER-LINE\n');
    assert.equal((await rpc.x.channels.connect({ profile: 'telegramtest', platform: 'telegram', token })).connected, true);
    try {
      await eventually(() => telegram.calls.some((call) => call.method === 'getUpdates'), 'Telegram adapter polling');
    } catch (error) {
      console.error('CHANNELS_DIAGNOSTIC', {
        status: await rpc.x.channels.status({ profile: 'telegramtest' }),
        health: (await rpc.extensions.list()).find((entry) => entry.id === 'channels'),
        calls: telegram.calls.map((entry) => entry.method).slice(0, 15),
      });
      throw error;
    }
    const projection = await readFile(envFile, 'utf8');
    assert.ok(projection.includes('# BEGIN NEO VAULT') && projection.includes(`TELEGRAM_BOT_TOKEN=${token}`)
      && projection.includes('# END NEO VAULT'), 'vault-owned key projected');
    const sqlite = await readFile(join(home, 'neo.sqlite'));
    assert.equal(sqlite.includes(Buffer.from(token)), false, 'vault DB does not contain plaintext Telegram token');
    assert.equal((await rpc.x.channels.status({ profile: 'telegramtest' })).platforms
      .find((p) => p.id === 'telegram')?.gatewayRunning, true);

    telegram.dm('Hello Hermes from isolated Telegram');
    await eventually(() => model.calls > 0, 'Hermes model turn', 45000);
    await eventually(() => telegram.calls.some((call) => call.method === 'sendMessage'
      && String(call.params.text).includes(reply)), 'Hermes replied to Telegram', 45000);
    assert.equal((await rpc.x.channels.connect({ profile: 'telegramtest', platform: 'telegram', token: rotated })).connected, true);
    await eventually(() => telegram.calls.filter((call) => call.method === 'getMe').length >= 2,
      'Telegram reconnect after token rotation');
    const rotatedEnv = await readFile(envFile, 'utf8');
    assert.ok(rotatedEnv.includes(rotated) && !rotatedEnv.includes(token), 'token rotation updates projection');
    assert.equal((await rpc.x.channels.disconnect({ profile: 'telegramtest', platform: 'telegram' })).disconnected, true);
    const disconnectedEnv = await readFile(envFile, 'utf8');
    assert.ok(!disconnectedEnv.includes(rotated) && disconnectedEnv.includes('# LOCAL USER-LINE'),
      'disconnect removes owned token and keeps unrelated user lines');

    await rpc.x.channels.connect({ profile: 'telegramtest', platform: 'telegram', token });
    const channelHealth = (await rpc.extensions.list()).find((entry) => entry.id === 'channels')?.health;
    const channelPid = (channelHealth as { pid?: number } | undefined)?.pid;
    assert.ok(channelPid, 'channel gateway has a tracked PID');
    const running = new Set([channelPid, ...descendants(channelPid).map((entry) => entry.pid)]);
    assert.ok(processRows().some((entry) => entry.pid === channelPid), 'channel gateway running');
    await rpc.extensions.disable({ id: 'channels' });
    await eventually(() => {
      const live = new Set(processRows().map((entry) => entry.pid));
      return [...running].every((pid) => !live.has(pid));
    }, 'Telegram gateway tree stopped');
    assert.equal((await fetch(base + '/x/channels/status')).status, 404);
    assert.equal((await fetch(base + '/x/sample-ts/hello', { headers })).status, 200);
    assert.equal((await rpc.extensions.list()).find((entry) => entry.id === 'engine-hermes')?.status, 'running');
    console.log('CHANNELS_GATEWAY_E2E PASS platforms=dynamic projected=encrypted rotate=updated telegram=roundtrip disconnect=clean disabled=404 sample=healthy');
  } catch (error) {
    console.error('CHANNELS_E2E_ERROR', error, app?.error);
    throw error;
  } finally {
    await closeGateway(app?.child);
    telegram.server.closeAllConnections();
    model.server.closeAllConnections();
    await Promise.all([new Promise<void>((done) => telegram.server.close(() => done())),
      new Promise<void>((done) => model.server.close(() => done()))]);
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
}

await main();
