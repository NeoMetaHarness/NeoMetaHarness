import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gatewayReady } from './gateway-ready.mjs';

function fixture(script, args = []) {
  const child = spawn(process.execPath, ['-e', script, ...args], {
    windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  return child;
}

test('delayed readiness returns its validated port and token', async () => {
  const child = fixture(`setTimeout(()=>{
    console.log('NEO_DESKTOP_TOKEN fake-test-token');
    console.log('GATEWAY_READY {"port":45678}');
  },150)`);
  let token;
  const closed = once(child, 'close');
  assert.equal(await gatewayReady(child, { timeoutMs: 5000, onToken: value => { token = value; } }), 45678);
  assert.equal(token, 'fake-test-token');
  await closed;
});

test('startup timeout kills grandchildren and releases their SQLite file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neo-gateway-timeout-'));
  const dbFile = join(root, 'state.sqlite');
  const child = fixture(`
    const {spawn}=require('node:child_process');
    const code="const db=new (require('node:sqlite').DatabaseSync)(process.argv[1]);db.exec('CREATE TABLE held(id)');console.log(process.pid);setInterval(()=>{},1000)";
    const worker=spawn(process.execPath,['-e',code,process.argv[1]],{stdio:['ignore','pipe','ignore'],windowsHide:true});
    worker.stdout.pipe(process.stdout);setInterval(()=>{},1000);
  `, [dbFile]);
  const [chunk] = await once(child.stdout, 'data');
  const workerPid = Number(chunk.toString().trim());
  assert.ok(Number.isInteger(workerPid) && workerPid > 0);
  assert.ok((await stat(dbFile)).isFile());
  try {
    await assert.rejects(gatewayReady(child, { timeoutMs: 25 }), /Gateway startup timed out after 25ms/);
    assert.throws(() => process.kill(workerPid, 0), { code: 'ESRCH' });
    await rm(root, { recursive: true, force: true });
    await assert.rejects(stat(root), { code: 'ENOENT' });
  } finally {
    child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('an early process failure keeps its original exit error', async () => {
  const child = fixture('process.exit(7)');
  await assert.rejects(gatewayReady(child, { timeoutMs: 5000 }), /Gateway exited 7/);
});
