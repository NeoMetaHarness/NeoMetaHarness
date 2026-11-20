import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { startGateway } from '../src/server.js';
import { FakeRfbServer } from '../../../extensions/computer-vnc/test/fake-rfb.js';
import { HttpOrgoClient, type OrgoClient } from '../../../extensions/computer-orgo/src/provider.js';

const root = await mkdtemp(join(tmpdir(), 'neo-p310-'));
const fakeRfb = await new FakeRfbServer().start();
const key = 'test-fake-orgo-key';
const workspaceId = randomUUID();
const actions: Array<{ id: string; type: string; body?: any }> = [];
const computers = new Map<string, { id: string; workspace_id: string; os: string }>();
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uVUAAAAASUVORK5CYII=';
let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;

const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const parts = url.pathname.split('/').filter(Boolean);
  let status = 200;
  let result: unknown = { success: true };
  if (request.headers.authorization !== 'Bearer ' + key) {
    status = 401;
    result = { error: key }; // Ensure client errors never reflect even a malicious server's body.
  } else if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'computers' && request.method === 'POST') {
    const id = randomUUID();
    const computer = { id, workspace_id: body.workspace_id, os: body.os };
    computers.set(id, computer);
    actions.push({ id, type: 'create', body });
    status = 201;
    result = computer;
  } else if (parts.length >= 3 && parts[0] === 'api' && parts[1] === 'computers') {
    const id = parts[2];
    if (!computers.has(id)) {
      status = 404;
      result = { error: 'Computer missing' };
    } else if (request.method === 'GET' && parts.length === 3) {
      const computer = computers.get(id)!;
      result = { id, project_id: computer.workspace_id, os: computer.os };
    } else if (request.method === 'GET' && parts[3] === 'screenshot') {
      assert.equal(url.searchParams.get('response_format'), 'base64');
      assert.equal(url.searchParams.get('format'), 'png');
      result = { success: true, image: png, width: 1, height: 1 };
      actions.push({ id, type: 'capture' });
    } else if (request.method === 'POST' && parts[3] === 'stop') {
      actions.push({ id, type: 'stop' });
    } else if (request.method === 'DELETE' && parts.length === 3) {
      actions.push({ id, type: 'delete' });
      computers.delete(id);
    } else if (request.method === 'POST' && ['click','mouse-move','type','key','scroll'].includes(parts[3])) {
      actions.push({ id, type: parts[3], body });
    } else {
      status = 404;
      result = { error: 'Unknown action' };
    }
  } else {
    status = 404;
    result = { error: 'Unknown endpoint' };
  }
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(result));
});

const oldEnv = Object.fromEntries(['PATH', 'NMH_DOCKER_CLI', 'NMH_TEST_DOCKER_PORT',
  'NMH_TEST_DOCKER_HOST', 'NMH_TEST_DOCKER_LOG'].map(name => [name, process.env[name]]));
const localCalls: string[] = [];
let driverCloses = 0;

try {
  const port = await new Promise<number>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port));
  });
  // The injected fake is intentionally separate from the production HTTPS egress client.
  const fakeClient: OrgoClient = { async request<T>(token: string, method: string, path: string, body?: object): Promise<T> {
    const response = await fetch('http://127.0.0.1:' + port + '/api' + path, {
      method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
    });
    if (!response.ok) throw new Error('Orgo fake API request failed');
    return response.json() as Promise<T>;
  } };
  assert.throws(() => new HttpOrgoClient('http://127.0.0.1:' + port + '/api'), /origin/);
  let privateFetches = 0;
  const fakeTransport = (async (_url: string, options: RequestInit) => {
    privateFetches++;
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;
  await assert.rejects(new HttpOrgoClient('https://127.0.0.1/api', fakeTransport)
    .request(key, 'GET', '/computers'), /Orgo API request failed/);
  assert.equal(privateFetches, 0);
  await new HttpOrgoClient('https://127.0.0.1/api', fakeTransport, true).request(key, 'GET', '/computers');
  assert.equal(privateFetches, 1);

  const bin = join(root, 'bin');
  await mkdir(bin);
  const dockerLog = join(root, 'docker.log');
  await writeFile(join(bin, 'docker.cmd'), [
    '@echo off',
    '>>"%NMH_TEST_DOCKER_LOG%" echo %*',
    'if "%1"=="run" (',
    '  echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '  exit /b 0',
    ')',
    'if "%1"=="port" (',
    '  echo %NMH_TEST_DOCKER_HOST%:%NMH_TEST_DOCKER_PORT%',
    '  exit /b 0',
    ')',
    'if "%1"=="stop" exit /b 0',
    'if "%1"=="kill" exit /b 0',
    'if "%1"=="rm" exit /b 0',
    'exit /b 2',
    '',
  ].join('\r\n'));
  process.env.PATH = bin + delimiter + (oldEnv.PATH ?? '');
  process.env.NMH_DOCKER_CLI = 'docker.cmd';
  process.env.NMH_TEST_DOCKER_PORT = String(fakeRfb.port);
  process.env.NMH_TEST_DOCKER_HOST = '127.0.0.1';
  process.env.NMH_TEST_DOCKER_LOG = dockerLog;

  gateway = await startGateway({
    databaseFile: join(root, 'neo.sqlite'), dataDir: root,
    extensionsDir: resolve('..', '..', 'extensions'), mode: 'desktop',
    orgoClient: fakeClient,
    computerLocalDriverFactory: () => ({
      screenshot: async () => ({ png, width: 1, height: 1 }),
      click: async (x, y) => { localCalls.push('click:' + x + ',' + y); },
      move: async () => {},
      type: async () => {},
      key: async () => {},
      scroll: async () => {},
      close: async () => { driverCloses++; },
    }),
  });
  const base = 'http://127.0.0.1:' + gateway.port;
  const rpc = createORPCClient<any>(new RPCLink({ url: base,
    headers: { authorization: 'Bearer ' + gateway.desktopToken } }));
  const anonymous = createORPCClient<any>(new RPCLink({ url: base }));

  assert.equal((await rpc.extensions.enable({ id: 'computer-local' })).status, 'running');
  assert.equal((await rpc.extensions.enable({ id: 'computer-docker' })).status, 'running');
  assert.equal((await rpc.extensions.enable({ id: 'computer-orgo' })).status, 'running');
  const gatewayWorkspaceId = (await gateway.auth.kysely.selectFrom('organization')
    .select('id').executeTakeFirstOrThrow()).id;
  await rpc.vault.put({ scope: { kind: 'workspace', workspaceId: gatewayWorkspaceId },
    name: 'VNC_PASSWORD', value: 'password' });


  await rpc.settings.set({ extension: 'computer-orgo', values: { workspaceId, apiKey: key } });
  const saved = await rpc.settings.get({ extension: 'computer-orgo' });
  assert.deepEqual(saved.values.apiKey, { set: true });
  assert.ok(!JSON.stringify(saved).includes(key));
  assert.equal((await gateway.kernel.getSettings('computer-orgo', gatewayWorkspaceId)).values.workspaceId, workspaceId);
  assert.equal(await gateway.vault.get({ kind: 'engine', workspaceId: gatewayWorkspaceId, subjectId: 'computer-orgo' }, 'SEC_APIKEY'), key);
  await assert.rejects(anonymous.computers.provision({ providerId: 'computer-orgo', spec: {} }),
    (e: any) => e.code === 'UNAUTHORIZED');

  await rpc.computers.local.set({ enabled: true });
  const local = await rpc.computers.attach({ providerId: 'computer-local', target: 'local-desktop' });
  const docker = await rpc.computers.provision({ providerId: 'computer-docker', spec: {
    image: 'neo/test-desktop:v1', vncPort: 5900, secretName: 'VNC_PASSWORD',
  } });
  const orgo = await rpc.computers.provision({ providerId: 'computer-orgo', spec: {} });
  assert.equal(orgo.providerId, 'computer-orgo');
  assert.equal(actions.find(action => action.type === 'create')?.body?.workspace_id, workspaceId);

  const bot = 'scripted-p310';
  const act = async (binding: any, body: object) => fetch(binding.endpoint, {
    method: 'POST', headers: { authorization: 'Bearer ' + binding.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ids = [local.id, docker.id, orgo.id];
  for (const [index, id] of ids.entries()) {
    await rpc.computers.assign({ engine: 'hermes', targetId: bot, computerId: id });
    const binding: { endpoint: string; token: string; computerId: string } = gateway.computers.binding('hermes', bot)!;
    assert.equal(binding.computerId, id);
    const coords = index === 1 ? { x: 3, y: 3 } : { x: 10 + index, y: 20 + index };
    assert.equal((await act(binding, { action: 'click', ...coords })).status, 200);
    assert.equal((await act(binding, { action: 'capture' })).status, 200);
    const image = await rpc.computers.capture({ id });
    assert.equal(image.width > 0, true);
    if (index) {
      const stale = gateway.computers.binding('hermes', bot);
      assert.equal(stale?.computerId, id);
    }
  }

  // Two distinct Neo workspaces may point at the same Orgo account. They must remain isolated.
  const otherNeoWorkspace = randomUUID();
  await assert.rejects(gateway.computers.provision('computer-orgo', {}, { workspaceId: otherNeoWorkspace }),
    /Orgo workspace ID missing/);
  await gateway.kernel.saveSettings('computer-orgo', { workspaceId }, otherNeoWorkspace);
  await assert.rejects(gateway.computers.provision('computer-orgo', {}, { workspaceId: otherNeoWorkspace }),
    /Orgo API key missing/);
  await gateway.kernel.saveSettings('computer-orgo', { apiKey: key }, otherNeoWorkspace);
  const orgoRemote = actions.find(a => a.type === 'create')!.id;
  const actionCount = actions.length;
  await assert.rejects(gateway.computers.attach('computer-orgo', orgoRemote,
    { workspaceId: otherNeoWorkspace }), /workspace mismatch/);
  assert.equal(actions.length, actionCount, 'cross-workspace attach never touches the Orgo API');
  for (const id of [orgo.id, local.id]) {
    assert.throws(() => gateway!.computers.assertWorkspace(id, otherNeoWorkspace), /workspace mismatch/);
  }
  assert.ok(!gateway.computers.list(otherNeoWorkspace).some((entry) => entry.id === orgo.id));
  const otherComputer = await gateway.computers.provision('computer-orgo', {}, { workspaceId: otherNeoWorkspace });
  const otherBinding = gateway.computers.assign('dsh', 'other-workspace-bot', otherComputer.id);
  gateway.computers.kill(true, otherNeoWorkspace);
  assert.equal((await act(otherBinding, { action: 'click', x: 1, y: 1 })).status, 403);
  assert.equal((await act(gateway.computers.binding('hermes', bot)!, { action: 'click', x: 2, y: 3 })).status, 200);
  gateway.computers.kill(false, otherNeoWorkspace);
  await assert.rejects(gateway.computers.attach('computer-orgo', actions.find(a => a.type === 'create' && a.id !== orgoRemote)!.id,
    { workspaceId: gatewayWorkspaceId }), /workspace mismatch/);
  await gateway.computers.terminate(otherComputer.id);

  assert.deepEqual(localCalls, ['click:10,20']);
  assert.ok(actions.some(a => a.type === 'click' && a.body.x === 12));
  const orgoBinding = gateway.computers.binding('hermes', bot)!;
  assert.equal((await act(orgoBinding, { action: 'key', keys: 'Ctrl+A' })).status, 403);
  await rpc.computers.policy.set({ id: orgo.id, allowDestructiveKeys: true, navigationOrigins: [] });
  assert.equal((await act(orgoBinding, { action: 'key', keys: 'Ctrl+A' })).status, 200);
  await rpc.computers.lease({ id: orgo.id, holder: 'human' });
  assert.equal((await act(orgoBinding, { action: 'click', x: 1, y: 2 })).status, 403);
  await rpc.computers.lease({ id: orgo.id, holder: 'agent' });
  await rpc.computers.assign({ engine: 'dsh', targetId: 'other-bot', computerId: docker.id });
  const second = gateway.computers.binding('dsh', 'other-bot')!;
  await rpc.computers.kill({ engaged: true });
  assert.equal((await act(orgoBinding, { action: 'click', x: 1, y: 2 })).status, 403);
  assert.equal((await act(second, { action: 'click', x: 1, y: 2 })).status, 403);
  await rpc.computers.kill({ engaged: false });
  assert.equal((await act(orgoBinding, { action: 'click', x: 3, y: 4 })).status, 200);
  assert.equal((await act(second, { action: 'click', x: 3, y: 4 })).status, 200);

  const actionEvents: any[] = [];
  for await (const event of gateway.kernel.events.subscribe(0)) {
    if (event.type === 'computer.action') actionEvents.push(event);
    if (actionEvents.length >= 13) break;
  }
  assert.ok(actionEvents.some(e => e.providerId === 'computer-orgo' && e.outcome === 'denied'));
  assert.ok(actionEvents.some(e => e.providerId === 'computer-orgo' && e.outcome === 'allowed'));

  await rpc.computers.release({ id: orgo.id });
  assert.ok(actions.some(a => a.type === 'stop'));
  assert.equal((await act(orgoBinding, { action: 'click', x: 9, y: 9 })).status, 403);
  const third = await rpc.computers.provision({ providerId: 'computer-orgo', spec: {} });
  await rpc.computers.terminate({ id: third.id });
  assert.ok(actions.some(a => a.type === 'delete'));
  const attachedId = actions.find(a => a.type === 'create')!.id;
  const attached = await rpc.computers.attach({ providerId: 'computer-orgo', target: attachedId });
  await rpc.computers.release({ id: attached.id });
  assert.equal(actions.filter(a => a.type === 'stop').length, 1, 'attached computers are only detached');
  const fourth = await rpc.computers.provision({ providerId: 'computer-orgo', spec: {} });
  await rpc.extensions.disable({ id: 'computer-orgo' });
  assert.ok(!(await rpc.computers.list()).some((entry: any) => entry.id === fourth.id));
  assert.ok((await rpc.computers.list()).some((entry: any) => entry.id === docker.id));
  assert.equal((await act(second, { action: 'click', x: 3, y: 3 })).status, 200);
  await rpc.computers.release({ id: docker.id });
  await rpc.computers.local.set({ enabled: false });
  assert.ok(driverCloses > 0);
  assert.ok((await readFile(dockerLog, 'utf8')).includes('stop '));
  assert.ok(!JSON.stringify(actions).includes(key));

  console.log('P3-10 PASS authenticated=true fake-orgo-http=true vault-secret=true same-hermes-bot-swap=local,docker,orgo leases=true kill=true safety-audit=true release=true terminate=true disable-isolated=true');
} finally {
  if (gateway) await gateway.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await fakeRfb.close();
  for (const [name, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
}
