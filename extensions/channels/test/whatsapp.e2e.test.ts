// P6-5: WhatsApp channel through Hermes' WhatsApp platform (unmodified), with a fake
// bridge standing in for WhatsApp. Gateway auth: desktop token (HELPER-BRIEF.md).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';

const extension = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = resolve(extension, '../..');
const hermesReply = 'Hermes fake answer complete.';
const member = '15550001111';
const stranger = '15550002222';
type Client = ContractRouterClient<typeof neoContract>;

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function eventually<T>(check: () => Promise<T> | T, label: string, limit = 60000): Promise<NonNullable<T>> {
  const deadline = Date.now() + limit;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value as NonNullable<T>; }
    catch (error) { last = error; }
    await pause(200);
  }
  throw new Error(`${label} timed out (${String(last ?? 'condition remained false')})`);
}

function upstreamCache(): string {
  if (process.env.NMH_UPSTREAM_CACHE) return process.env.NMH_UPSTREAM_CACHE;
  for (let parent = repo; ; parent = dirname(parent)) {
    const candidate = join(parent, 'nmh-upstream-cache');
    if (existsSync(candidate)) return candidate;
    if (dirname(parent) === parent) throw new Error('Set NMH_UPSTREAM_CACHE to the pinned source cache');
  }
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

/** Scripted OpenAI-compatible model for Hermes (bot turns and native WhatsApp replies). */
function fakeHermesModel() {
  const prompts: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') { json(res, { object: 'list', data: [{ id: 'fake-model', object: 'model' }] }); return; }
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) { json(res, {}, 404); return; }
    const input = await readJson(req);
    // User content may be a string or a list of parts; keep its text either way.
    prompts.push(JSON.stringify([...input.messages ?? []].reverse().find((m: any) => m.role === 'user')?.content ?? ''));
    if (!input.stream) {
      json(res, { id: 'fake', object: 'chat.completion', model: 'fake-model',
        choices: [{ index: 0, message: { role: 'assistant', content: hermesReply }, finish_reason: 'stop' }] });
      return;
    }
    const chunk = (delta: object, finish: string | null) => ({ id: 'fake', object: 'chat.completion.chunk',
      created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: ' + JSON.stringify(chunk({ role: 'assistant', content: hermesReply }, null)) + '\n\n');
    res.end('data: ' + JSON.stringify(chunk({}, 'stop')) + '\n\ndata: [DONE]\n\n');
  });
  return { server, prompts };
}

/** Scripted superagent eval/plan model (same protocol as apps/neo-app/test/p6-1.mjs). */
function fakeDshModel() {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !['/evaluate', '/generate'].includes(req.url ?? '')) { res.writeHead(404).end(); return; }
    const request = await readJson(req);
    if (req.url === '/evaluate') { json(res, { decision: 'accept' }); return; }
    json(res, { action: request.stage === 1 ? 'delegate' : 'finish' });
  });
  return { server };
}

function processRows() {
  if (process.platform !== 'win32') {
    return execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).map(Number)).map(([pid, parent]) => ({ pid: pid!, parent: parent! }));
  }
  const powershell = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const data = execFileSync(powershell, ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
  { encoding: 'utf8', timeout: 20000, maxBuffer: 4_000_000 });
  return [JSON.parse(data) as { ProcessId: number; ParentProcessId: number }[]].flat()
    .map(({ ProcessId, ParentProcessId }) => ({ pid: ProcessId, parent: ParentProcessId }));
}

function tree(root: number): Set<number> {
  const rows = processRows();
  const found = new Set([root]);
  let size = 0;
  while (size !== found.size) {
    size = found.size;
    for (const row of rows) if (found.has(row.parent)) found.add(row.pid);
  }
  return found;
}

async function startGateway(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: join(repo, 'apps/gateway'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ...env, NMH_PORT: '0', NEO_MODE: 'desktop', NEO_PRINT_DESKTOP_TOKEN: '1' },
  });
  let stderr = '';
  child.stderr!.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-6000); });
  let token = '';
  const port = await Promise.race([new Promise<number>((done, reject) => {
    const reader = createInterface({ input: child.stdout! });
    reader.on('line', (line) => {
      if (line.startsWith('NEO_DESKTOP_TOKEN ')) token = line.slice('NEO_DESKTOP_TOKEN '.length).trim();
      if (line.startsWith('GATEWAY_READY ')) { reader.close(); done((JSON.parse(line.slice(14)) as { port: number }).port); }
    });
    child.once('exit', (code) => reject(new Error('Gateway exited ' + code + ' ' + stderr)));
  }), pause(30000).then(() => { throw new Error('Gateway startup timeout ' + stderr); })]);
  assert.ok(token, 'desktop token printed');
  return { child, port, token, get errors() { return stderr; } };
}

async function closeGateway(child?: ChildProcess) {
  if (!child || child.exitCode !== null) return;
  if (child.connected) child.send('shutdown');
  await Promise.race([new Promise<void>((done) => child.once('exit', () => done())), pause(10000)]);
  if (child.exitCode === null) {
    if (process.platform === 'win32') {
      execFileSync(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else child.kill('SIGKILL');
  }
}

async function main() {
  const temp = await mkdtemp(join(tmpdir(), 'nmh-whatsapp-'));
  const home = join(temp, 'hermes');
  const profileHome = join(home, 'profiles', 'watest');
  const session = join(profileHome, 'platforms', 'whatsapp', 'session');
  // The fake bridge lives in its own directory; a matching install stamp tells the adapter
  // its (dependency-free) package is installed (adapter.py _ensure_bridge_deps).
  const bridgeDir = join(temp, 'fake-bridge');
  const fixture = join(extension, 'test', 'fixtures', 'whatsapp-bridge');
  await mkdir(join(bridgeDir, 'node_modules'), { recursive: true });
  for (const file of ['bridge.mjs', 'package.json']) await copyFile(join(fixture, file), join(bridgeDir, file));
  const packageHash = createHash('sha256').update(await readFile(join(bridgeDir, 'package.json'))).digest('hex').slice(0, 16);
  await writeFile(join(bridgeDir, 'node_modules', '.hermes-pkg-hash'), packageHash);

  const hermes = fakeHermesModel();
  const dsh = fakeDshModel();
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  try {
    const hermesPort = await listen(hermes.server);
    const dshPort = await listen(dsh.server);
    gateway = await startGateway({
      NODE_ENV: 'test',
      NMH_SUPERAGENT_TEST_ADAPTER: new URL('../../engine-superagent/test/scripted-models.ts', import.meta.url).href,
      NMH_UPSTREAM_CACHE: upstreamCache(),
      NMH_DB_PATH: join(temp, 'neo.sqlite'), NMH_EXTENSIONS_DIR: join(repo, 'extensions'),
      NMH_HERMES_HOME: home, NMH_HERMES_MODEL_URL: `http://127.0.0.1:${hermesPort}/v1`,
      NMH_SUPERAGENT_MODEL_URL: `http://127.0.0.1:${dshPort}`,
      NMH_CHANNELS_WHATSAPP_BRIDGE_SCRIPT: join(bridgeDir, 'bridge.mjs'),
      // Shared Hermes PM store outside the repo: Hermes' pinned Node is downloaded once per machine,
      // then reused by each isolated temp root.
      NMH_HERMES_RUNTIME_DIR: process.env.NMH_HERMES_RUNTIME_DIR ?? join(tmpdir(), 'nmh-hermes-runtime'),
    });
    const base = `http://127.0.0.1:${gateway.port}`;
    const rpc = createORPCClient<Client>(new RPCLink({ url: base, headers: { authorization: `Bearer ${gateway.token}` } }));
    const anonymous = createORPCClient<Client>(new RPCLink({ url: base }));

    for (const id of ['sample-ts', 'engine-hermes', 'engine-superagent']) {
      const started = await rpc.extensions.enable({ id });
      assert.equal(started.status, 'running', started.reason ?? gateway.errors);
    }
    await rpc.x['engine-hermes'].profiles.create({ name: 'watest' });
    const bot = await rpc.agents.bots.create({ name: 'P6-5 WhatsApp Bot' });
    const channels = await rpc.extensions.enable({ id: 'channels' });
    assert.equal(channels.status, 'running', channels.reason ?? gateway.errors);

    const listed = (await rpc.x.channels.list({ profile: 'watest' })).platforms;
    assert.ok(listed.some((p) => p.id === 'whatsapp'), 'Hermes exposes its WhatsApp platform');
    const before = (await rpc.x.channels.status({ profile: 'watest' })).platforms.find((p) => p.id === 'whatsapp');
    assert.equal(before?.configured, false);
    assert.equal(before?.paired, false);
    await assert.rejects(() => anonymous.x.channels.allow({ profile: 'watest', platform: 'whatsapp', senderId: member, role: 'admin' }),
      { code: 'UNAUTHORIZED' }, 'sender allowlist needs an authenticated admin');
    console.log('P6-5_SETUP PASS platform=hermes-whatsapp auth=desktop-token anonymous=refused');

    // Device pairing (QR) happens in Hermes; the fake session stands for a linked device.
    await mkdir(session, { recursive: true });
    await writeFile(join(session, 'creds.json'), '{"fake":true}\n');
    assert.equal((await rpc.x.channels.connect({ profile: 'watest', platform: 'whatsapp', botId: bot.id })).connected, true);
    const config = parse(await readFile(join(profileHome, 'config.yaml'), 'utf8')) as any;
    assert.ok(config.plugins.enabled.includes('neo-channels'), 'neo-channels Hermes plugin enabled');
    const bridgePort = Number(config.platforms.whatsapp.extra.bridge_port);
    assert.ok(bridgePort > 0, 'per-profile bridge port');
    const binding = JSON.parse(await readFile(join(profileHome, 'plugins', 'neo-channels', 'binding.json'), 'utf8')) as
      { endpoint: string; token: string; profile: string };
    assert.match(binding.token, /^[0-9a-f]{64}$/);
    assert.equal(binding.endpoint, `${base}/internal/channels/whatsapp/inbound`);
    assert.equal((await readFile(join(temp, 'neo.sqlite'))).includes(Buffer.from(binding.token)), false,
      'callback token is encrypted in the vault');
    const envFile = await readFile(join(profileHome, '.env'), 'utf8').catch(() => '');
    assert.ok(!envFile.includes(binding.token), 'callback token is not projected into Hermes .env');

    // Bridge control uses the token Hermes mints for each bridge spawn.
    const bridge = async (path: string, body?: object) => {
      const token = (await readFile(join(session, '.bridge-token'), 'utf8')).trim();
      const response = await fetch(`http://127.0.0.1:${bridgePort}${path}`, {
        method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, 200, `bridge ${path}`);
      return response.json() as Promise<any>;
    };
    const sentTo = async (who: string) => ((await bridge('/__test/sent')) as { chatId: string; message: string }[])
      .filter((entry) => entry.chatId === `${who}@s.whatsapp.net`);
    // Model answers only; Hermes also sends notices (e.g. its first-run "no home channel" hint).
    const answers = async (who: string) => (await sentTo(who)).filter((entry) => entry.message.includes(hermesReply)).length;
    const dm = (from: string, text: string) => bridge('/__test/inbound', { from, text });
    const ready = async () => { await eventually(() => bridge('/health').then((h) => h.status === 'connected'), 'bridge up'); };
    await ready();
    const status = (await rpc.x.channels.status({ profile: 'watest' })).platforms.find((p) => p.id === 'whatsapp');
    assert.deepEqual([status?.configured, status?.paired, status?.gatewayRunning], [true, true, true]);
    console.log('P6-5_CONNECT PASS plugin=enabled vault=encrypted env=clean bridge=connected');

    // The callback endpoint checks the per-profile vault token.
    const callback = (authorization: string, text: string) => fetch(binding.endpoint, {
      method: 'POST', headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'watest', platform: 'whatsapp', chatId: `${stranger}@s.whatsapp.net`,
        chatType: 'dm', senderId: `${stranger}@s.whatsapp.net`, messageId: 'probe', text }),
    });
    assert.equal((await callback('Bearer ' + 'f'.repeat(64), '@neo hi')).status, 401, 'wrong callback token refused');
    assert.deepEqual(await (await callback('Bearer ' + binding.token, '@neo hi')).json(), { action: 'allow' },
      'an unknown sender stays with Hermes');

    // Allowlisted member addressing @neo: Neo Inbox (neo/channel), report back on WhatsApp.
    assert.deepEqual((await rpc.x.channels.allow({ profile: 'watest', platform: 'whatsapp', senderId: member, role: 'member' })).senders,
      [{ senderId: member, role: 'member' }]);
    await ready();
    await dm(member, '@neo do whatsapp research');
    const report = await eventually(async () => (await rpc.inbox.list()).find((item) => item.source === 'neo/channel'
      && item.text === 'do whatsapp research' && item.status === 'ready'), 'Inbox report from WhatsApp', 90000);
    assert.equal(report.requesterRole, 'member');
    assert.equal(report.botId, bot.id);
    await eventually(async () => (await sentTo(member)).find((entry) => entry.message.includes(hermesReply)),
      'report delivered to WhatsApp', 60000);
    await pause(4000);
    assert.equal((await sentTo(member)).length, 1, 'Hermes did not also answer the @neo message');
    console.log('P6-5_INBOUND PASS source=neo/channel role=member report=ready reply=whatsapp hermes=skipped');

    // A message not addressed to @neo is Hermes' own conversation.
    await dm(member, 'hello hermes');
    await eventually(async () => await answers(member) === 2, 'Hermes answered natively', 60000);
    assert.ok(hermes.prompts.some((prompt) => prompt.includes('hello hermes')),
      `Hermes model saw the plain message (sent: ${JSON.stringify((await sentTo(member)).map((e) => e.message.slice(0, 120)))}; `
      + `prompts: ${JSON.stringify(hermes.prompts.map((p) => p.slice(0, 120)))})`);
    console.log('P6-5_PASSTHROUGH PASS plain=hermes');

    // Unknown sender: Hermes DMs a pairing code; an admin approves it with a role.
    await dm(stranger, '@neo let me in');
    const pairing = await eventually(async () => (await sentTo(stranger))
      // The reply carries the approve command (gateway/run_inbound_unauthorized.py:40-46).
      .map((entry) => /pairing approve whatsapp ([A-HJ-NP-Z2-9]{8})\b/.exec(entry.message)?.[1]).find(Boolean),
    'Hermes pairing code', 60000);
    assert.ok(!(await rpc.inbox.list()).some((item) => item.text.includes('let me in')), 'unpaired sender never reaches the Inbox');
    assert.deepEqual(await rpc.x.channels.approve({ profile: 'watest', platform: 'whatsapp', code: pairing, role: 'viewer' }),
      { senderId: stranger, role: 'viewer' });
    await ready();
    await dm(stranger, '@neo delete the customer database');
    const blocked = await eventually(async () => (await rpc.inbox.list()).find((item) => item.source === 'neo/channel'
      && item.requesterRole === 'viewer' && item.status === 'blocked'), 'viewer request blocked', 60000);
    assert.match(blocked.report?.summary ?? '', /Viewer role/i);
    await eventually(async () => (await sentTo(stranger)).some((entry) => /Viewer role/i.test(entry.message)),
      'blocked report delivered to WhatsApp', 60000);
    console.log('P6-5_PAIRING PASS code=hermes approve=viewer act=blocked reply=whatsapp');

    // Revoke: the sender's @neo messages no longer reach the Inbox.
    assert.deepEqual((await rpc.x.channels.revoke({ profile: 'watest', platform: 'whatsapp', senderId: stranger })).senders,
      [{ senderId: member, role: 'member' }]);
    await ready();
    const itemsBefore = (await rpc.inbox.list()).length;
    await dm(stranger, '@neo still there?');
    await pause(5000);
    assert.equal((await rpc.inbox.list()).length, itemsBefore, 'revoked sender is not routed to the Inbox');
    console.log('P6-5_REVOKE PASS inbox=closed');

    // Inbox off: @neo messages fall back to Hermes, the channel stays healthy.
    await rpc.extensions.disable({ id: 'engine-superagent' });
    const answered = await answers(member);
    await dm(member, '@neo inbox is off');
    await eventually(async () => await answers(member) === answered + 1, 'Hermes answers while the Inbox is off', 60000);
    assert.ok(hermes.prompts.some((prompt) => prompt.includes('inbox is off')), 'Hermes handled the @neo message itself');
    assert.equal((await rpc.extensions.list()).find((entry) => entry.id === 'channels')?.health?.ok, true);
    console.log('P6-5_INBOX_OFF PASS fallback=hermes channels=healthy');

    // Disconnect removes Neo's plugin binding and the vault token.
    assert.equal((await rpc.x.channels.disconnect({ profile: 'watest', platform: 'whatsapp' })).disconnected, true);
    assert.equal(existsSync(join(profileHome, 'plugins', 'neo-channels')), false, 'plugin removed');
    assert.equal((await callback('Bearer ' + binding.token, '@neo hi')).status, 401, 'old callback token is dead');
    const disconnected = (await rpc.x.channels.status({ profile: 'watest' })).platforms.find((p) => p.id === 'whatsapp');
    assert.deepEqual([disconnected?.configured, disconnected?.gatewayRunning], [false, false]);
    console.log('P6-5_DISCONNECT PASS plugin=removed token=revoked');

    // Disabled-healthy: disabling Channels stops the Hermes gateway and bridge; the rest keeps running.
    await rpc.x.channels.connect({ profile: 'watest', platform: 'whatsapp', botId: bot.id });
    await ready();
    const pid = ((await rpc.extensions.list()).find((entry) => entry.id === 'channels')?.health as { pid?: number })?.pid;
    assert.ok(pid, 'channel gateway pid');
    const running = tree(pid);
    assert.ok(running.size > 1, 'gateway has children (the bridge)');
    await rpc.extensions.disable({ id: 'channels' });
    await eventually(() => { const live = new Set(processRows().map((row) => row.pid)); return [...running].every((p) => !live.has(p)); },
      'Hermes gateway and WhatsApp bridge stopped');
    await assert.rejects(() => rpc.x.channels.status({ profile: 'watest' }), { code: 'NOT_FOUND' });
    assert.equal((await callback('Bearer ' + binding.token, '@neo hi')).status, 404, 'callback endpoint gone');
    assert.equal((await fetch(base + '/x/sample-ts/hello', { headers: { authorization: `Bearer ${gateway.token}` } })).status, 200);
    assert.equal((await rpc.extensions.list()).find((entry) => entry.id === 'engine-hermes')?.status, 'running');
    console.log('P6-5_DISABLE PASS processes=stopped channels=404 others=healthy');
    console.log('P6-5 PASS whatsapp=hermes-platform bridge=fake inbox=neo/channel auth=desktop-token');
  } catch (error) {
    console.error('P6-5_ERROR', error, gateway?.errors);
    // Hermes' own logs for the profile (gateway + bridge), to diagnose platform start-up.
    for (const file of [join(profileHome, 'logs', 'gateway.log'), join(profileHome, 'logs', 'errors.log'),
      join(profileHome, 'platforms', 'whatsapp', 'bridge.log')]) {
      const text = await readFile(file, 'utf8').catch(() => '');
      if (text) console.error(`--- ${file}\n${text.slice(-3000)}`);
    }
    throw error;
  } finally {
    await closeGateway(gateway?.child);
    for (const server of [hermes.server, dsh.server]) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

await main();
