import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { startGateway } from '../src/server.js';
import { FakeRfbServer } from '../../../extensions/computer-vnc/test/fake-rfb.js';

const root = await mkdtemp(join(tmpdir(), 'neo-p36-'));
const bin = join(root, 'bin');
const log = join(root, 'docker-args.log');
const fake = await new FakeRfbServer().start();
const originalPath = process.env.PATH;
const originalShim = process.env.NMH_DOCKER_CLI;
const originalPort = process.env.NMH_TEST_DOCKER_PORT;
const originalHost = process.env.NMH_TEST_DOCKER_HOST;
const originalLog = process.env.NMH_TEST_DOCKER_LOG;
let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;

async function eventually(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(label + ' timed out');
}

try {
  await mkdir(bin);
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
  ].join('\r\n'), 'utf8');
  process.env.PATH = bin + delimiter + (originalPath ?? '');
  process.env.NMH_DOCKER_CLI = 'docker.cmd';
  process.env.NMH_TEST_DOCKER_PORT = String(fake.port);
  process.env.NMH_TEST_DOCKER_HOST = '127.0.0.1';
  process.env.NMH_TEST_DOCKER_LOG = log;

  gateway = await startGateway({
    databaseFile: join(root, 'neo.sqlite'), dataDir: root,
    extensionsDir: resolve('..', '..', 'extensions'), mode: 'desktop',
  });
  const base = `http://127.0.0.1:${gateway.port}`;
  const token = gateway.desktopToken;
  assert.ok(token, 'desktop gateway must issue authenticated token');
  const rpc = createORPCClient(new RPCLink({ url: base, headers: { authorization: `Bearer ${token}` } }));
  const anonymous = createORPCClient(new RPCLink({ url: base }));
  assert.equal((await rpc.extensions.enable({ id: 'computer-docker' })).status, 'running');
  assert.equal((await rpc.extensions.enable({ id: 'sample-ts' })).status, 'running');
  const workspaceId = (await gateway.auth.kysely.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id;
  await rpc.vault.put({ scope: { kind: 'workspace', workspaceId }, name: 'VNC_PASSWORD', value: 'password' });
  const spec = { image: 'neo/test-desktop:v1', vncPort: 5900, secretName: 'VNC_PASSWORD' };
  const request = { providerId: 'computer-docker', spec };

  await assert.rejects(anonymous.computers.provision(request), (error: any) => error.code === 'UNAUTHORIZED');
  await assert.rejects(rpc.computers.provision({
    ...request, spec: { ...spec, image: 'bad;touch-bad' },
  }), (error: any) => error.code === 'BAD_REQUEST');
  await assert.rejects(rpc.computers.provision({
    ...request, spec: { ...spec, secretName: 'MISSING_SECRET' },
  }), (error: any) => error.code === 'BAD_REQUEST');

  const first = await rpc.computers.provision(request);
  assert.match(first.id, /^neo-[0-9a-f]{24}$/);
  assert.equal(first.providerId, 'computer-docker');
  assert.equal(first.holder, 'agent');
  assert.equal(fake.authenticated, 1);
  const capture = await rpc.computers.capture({ id: first.id });
  assert.equal(capture.width, 8);
  assert.equal(capture.height, 6);
  assert.ok(Buffer.from(capture.png, 'base64').subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'VNC framebuffer rendered to PNG');

  await rpc.computers.assign({ engine: 'dsh', targetId: 'docker-bot', computerId: first.id });
  const binding = gateway.computers.binding('dsh', 'docker-bot');
  assert.ok(binding);
  const action = (input: object) => fetch(binding.endpoint, {
    method: 'POST', headers: { authorization: `Bearer ${binding.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  assert.equal((await action({ action: 'click', x: 3, y: 3 })).status, 200);
  assert.notEqual((await rpc.computers.capture({ id: first.id })).png, capture.png, 'input updates the existing VNC viewer framebuffer');
  assert.ok(fake.pointers.length > 0, 'input uses RFB pointer protocol');
  assert.equal((await rpc.computers.lease({ id: first.id, holder: 'human' })).holder, 'human');
  assert.equal((await action({ action: 'click', x: 3, y: 3 })).status, 403);
  assert.equal((await rpc.computers.capture({ id: first.id })).width, 8, 'human lease leaves viewer active');
  assert.equal((await rpc.computers.lease({ id: first.id, holder: 'agent' })).holder, 'agent');
  assert.equal((await action({ action: 'key', keys: 'Enter' })).status, 200);
  await rpc.computers.kill({ engaged: true });
  assert.equal((await action({ action: 'click', x: 3, y: 3 })).status, 403);
  await rpc.computers.kill({ engaged: false });
  assert.equal((await action({ action: 'move', x: 2, y: 2 })).status, 200);

  assert.deepEqual(await rpc.computers.release({ id: first.id }), { released: true });
  await eventually(() => fake.sockets.size === 0, 'release closes RFB');
  assert.equal((await action({ action: 'click', x: 3, y: 3 })).status, 403, 'release revokes capability token');
  assert.ok(!(await rpc.computers.list()).some((entry: any) => entry.id === first.id));

  const second = await rpc.computers.provision(request);
  assert.deepEqual(await rpc.computers.terminate({ id: second.id }), { terminated: true });
  await eventually(() => fake.sockets.size === 0, 'terminate closes RFB');

  process.env.NMH_TEST_DOCKER_HOST = '0.0.0.0';
  await assert.rejects(rpc.computers.provision(request), (error: any) => error.code === 'BAD_REQUEST');
  process.env.NMH_TEST_DOCKER_HOST = '127.0.0.1';

  const third = await rpc.computers.provision(request);
  assert.ok((await rpc.computers.list()).some((entry: any) => entry.id === third.id));
  await rpc.extensions.disable({ id: 'computer-docker' });
  await eventually(() => fake.sockets.size === 0, 'disable closes RFB');
  assert.ok(!(await rpc.computers.list()).some((entry: any) => entry.id === third.id));
  await assert.rejects(rpc.computers.provision(request), (error: any) => error.code === 'BAD_REQUEST');
  assert.equal((await fetch(base + '/x/sample-ts/hello', { headers: { authorization: `Bearer ${token}` } })).status, 200);

  const lines = (await readFile(log, 'utf8')).split(/\r?\n/).filter(Boolean);
  const runs = lines.filter(line => line.startsWith('run '));
  assert.equal(runs.length, 4, 'four Docker launches including rejected non-loopback port');
  for (const line of runs) {
    assert.match(line, /--pull=never/);
    assert.match(line, /--publish 127\.0\.0\.1::5900\/tcp/);
    assert.match(line, /--env VNC_PASSWORD/);
    assert.doesNotMatch(line, /(?:^|\s)password(?:\s|$)/i, 'password value stays out of arguments');
  }
  assert.ok(lines.some(line => line.startsWith('stop ')));
  assert.ok(lines.some(line => line.startsWith('kill ')));
  assert.ok(lines.some(line => line.startsWith('rm ')));
  assert.ok(lines.every(line => !line.startsWith('pull ')), 'no image pulls');
  console.log('P3-6 PASS authenticated=true vault-scoped=true fake-docker-path=true no-pulls=true loopback-only=true rfb-capture+input=true lease+handover=true kill=true release+terminate=true disabled-cleanup=true siblings-healthy=true');
} finally {
  if (gateway) await gateway.close();
  await fake.close();
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const [name, value] of Object.entries({
    NMH_DOCKER_CLI: originalShim, NMH_TEST_DOCKER_PORT: originalPort,
    NMH_TEST_DOCKER_HOST: originalHost, NMH_TEST_DOCKER_LOG: originalLog,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
}
