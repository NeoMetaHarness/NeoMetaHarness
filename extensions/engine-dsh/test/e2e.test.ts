import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import { WebSocket } from 'ws';
import { neoContract, type DshEvent } from '@neometaharness/contracts';
import { DshProjector } from '@neometaharness/vault';
import { startGateway } from '../../../apps/gateway/src/server.js';

type Client = ContractRouterClient<typeof neoContract>;
const repo = fileURLToPath(new URL('../../../', import.meta.url));

function cacheRoot(): string {
  if (process.env.NMH_UPSTREAM_CACHE) return process.env.NMH_UPSTREAM_CACHE;
  for (let dir = repo; ; dir = dirname(dir)) {
    const candidate = join(dir, 'nmh-upstream-cache');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error('Set NMH_UPSTREAM_CACHE to upstream sources');
  }
}

async function timeout<T>(promise: Promise<T>, label: string, ms = 45000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function processTree(): { pid: number; ppid: number }[] {
  if (process.platform !== 'win32') return [];
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const exe = join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const json = execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true });
  const records = JSON.parse(json) as { ProcessId: number; ParentProcessId: number }[];
  return records.map((row) => ({ pid: row.ProcessId, ppid: row.ParentProcessId }));
}

function children(pids: readonly number[]): number[] {
  const tree = processTree();
  const descendants = new Set(pids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of tree) {
      if (descendants.has(node.ppid) && !descendants.has(node.pid)) {
        descendants.add(node.pid);
        changed = true;
      }
    }
  }
  return [...descendants];
}

async function stopped(pids: number[]): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (pids.every((pid) => !alive(pid))) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.deepEqual(pids.filter(alive), [], 'DSH process tree must exit on disable');
}

async function run() {
  const ref = (JSON.parse(await readFile(join(repo, 'upstream.lock.json'), 'utf8')) as
    { pins: { 'deepseek-harness': { ref: string } } }).pins['deepseek-harness'].ref;
  assert.equal(ref, '0.2.2-rc.1');
  assert.ok(existsSync(join(cacheRoot(), `deepseek-harness@${ref}`)), 'pinned upstream cache required');
  assert.equal(JSON.parse(await readFile(join(repo, 'extensions/engine-dsh/node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version, ref);

  process.env.NEO_TEST_SECRET = 'never-in-dsh';
  const projected = await new DshProjector().project(new Map());
  assert.ok(!('NEO_TEST_SECRET' in projected), 'unrelated parent secrets must be excluded');
  const temp = await mkdtemp(join(tmpdir(), 'nmh-dsh-gateway-'));
  const gateway = await startGateway({
    databaseFile: join(temp, 'state/neo.sqlite'),
    extensionsDir: join(repo, 'extensions'),
  });
  const url = `http://127.0.0.1:${gateway.port}`;
  const http = createORPCClient<Client>(new HttpLink({ url }));
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`);
  const ws = createORPCClient<Client>(new WebSocketLink({ websocket: socket }));
  const launched: number[] = [];
  try {
    assert.equal((await http.extensions.enable({ id: 'sample-ts' })).status, 'running');
    assert.equal((await http.extensions.enable({ id: 'engine-dsh' })).status, 'running');
    const workspace = join(temp, 'workspace');
    await mkdir(workspace);
    const first = await timeout(http.x['engine-dsh'].create({ workspaceId: 'workspace-one', cwd: temp }), 'create first');
    const second = await timeout(http.x['engine-dsh'].create({ workspaceId: 'workspace-two', cwd: workspace }), 'create second');
    launched.push(first.pid, second.pid);
    assert.notEqual(first.pid, second.pid);
    assert.notEqual(first.sessionId, second.sessionId);
    const homes = join(temp, 'state/extensions/engine-dsh');
    const states = await readdir(homes);
    assert.equal(states.length, 2);
    for (const name of states) assert.ok(existsSync(join(homes, name, 'home')));

    const collect = (sessionId: string) => (async () => {
      const events: DshEvent[] = [];
      const ready = Promise.withResolvers<void>();
      const done = (async () => {
        for await (const event of await ws.x['engine-dsh'].events({ sessionId })) {
          events.push(event);
          if (event.kind === 'snapshot') ready.resolve();
        }
      })().catch((error) => { ready.reject(error); throw error; });
      await timeout(ready.promise, 'stream subscribe');
      return { events, done };
    })();
    const [one, two] = await timeout(Promise.all([collect(first.sessionId), collect(second.sessionId)]), 'subscribe');
    const [replyOne, replyTwo] = await timeout(Promise.all([
      http.x['engine-dsh'].prompt({ sessionId: first.sessionId, text: 'Say the scripted response.' }),
      http.x['engine-dsh'].prompt({ sessionId: second.sessionId, text: 'Say the scripted response.' }),
    ]), 'parallel prompts');
    assert.ok(replyOne.messageId && replyTwo.messageId);
    assert.deepEqual(await timeout(Promise.all([
      http.x['engine-dsh'].wait({ sessionId: first.sessionId }),
      http.x['engine-dsh'].wait({ sessionId: second.sessionId }),
    ]), 'parallel wait'), [{ status: 'settled' }, { status: 'settled' }]);
    await timeout(Promise.all([one.done, two.done]), 'streams settled');
    for (const [sessionId, { events }] of [[first.sessionId, one], [second.sessionId, two]] as const) {
      const chunks = events.filter((event) => event.kind === 'text.delta');
      assert.equal(chunks.map((event) => event.textDelta).join(''), 'Neo scripted DSH SDK reply.');
      assert.ok(chunks.some((event) => (event.coalescedCount ?? 0) >= 2), '33ms coalescing by message ID');
      const sequences = events.map((event) => event.sequence ?? 0);
      assert.ok(sequences.every((id, index) => index === 0 || id > sequences[index - 1]!));
      assert.ok(events.some((event) => event.type === 'session.settled'
        && (event.payload as { sessionId: string }).sessionId === sessionId));
    }
    assert.notEqual(one.events, two.events, 'session streams remain isolated');
    const third = await timeout(http.x['engine-dsh'].create({ workspaceId: 'workspace-one', cwd: temp }), 'create third');
    launched.push(third.pid);
    assert.deepEqual(await http.x['engine-dsh'].cancel({ sessionId: third.sessionId }), { cancelled: true });
    await stopped([third.pid]);
    const fourth = await timeout(http.x['engine-dsh'].create({ workspaceId: 'workspace-one', cwd: temp }), 'create fourth');
    launched.push(fourth.pid);
    assert.deepEqual(await http.x['engine-dsh'].shutdown({ sessionId: fourth.sessionId }), { stopped: true });
    await stopped([fourth.pid]);

    const allPids = children(launched);
    assert.equal((await http.extensions.disable({ id: 'engine-dsh' })).status, 'disabled');
    await stopped(allPids);
    assert.equal((await fetch(url + '/x/engine-dsh/create', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
    assert.deepEqual(await (await fetch(url + '/x/sample-ts/hello')).json(), { message: 'Hello from TypeScript' });
    console.log(`DSH_GATEWAY PASS sessions=2 coalesced=true ordered=true isolated=true cancel=true disable=404 tree=${allPids.length} sample=healthy`);
  } finally {
    socket.close();
    await gateway.close();
    await stopped(launched);
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    delete process.env.NEO_TEST_SECRET;
  }
}

await run();
