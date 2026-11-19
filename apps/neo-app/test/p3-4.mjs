import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { startGateway } from '../../gateway/src/server.ts';
import { FakeRfbServer } from '../../../extensions/computer-vnc/test/fake-rfb.ts';
import { HeadlessChromeProvider } from '../../../extensions/computer-headless-chrome/src/index.ts';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..'), repo = resolve(app, '../..');
async function eventually(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`${label} timed out: ${String(last ?? '')}`);
}
async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
class Browser {
  next = 0; pending = new Map();
  constructor(socket) {
    this.socket = socket;
    socket.addEventListener('message', event => {
      const result = JSON.parse(event.data), pending = this.pending.get(result.id);
      if (!pending) return; this.pending.delete(result.id); clearTimeout(pending.timer);
      result.error ? pending.reject(new Error('Browser protocol failed')) : pending.resolve(result.result);
    });
  }
  static async open(details) {
    // Since P7-5 (SEC-06) the headless Chrome provider speaks CDP over a pipe and hands
    // out a { targetId, send } channel instead of a debugging WebSocket URL.
    if (typeof details?.send === 'function') {
      const browser = Object.create(Browser.prototype);
      browser.pending = new Map();
      browser.send = (method, params = {}) => details.send(method, params, browser.session);
      browser.close = () => {};
      browser.session = (await details.send('Target.attachToTarget', { targetId: details.targetId, flatten: true })).sessionId;
      await browser.send('Page.enable'); return browser;
    }
    const socket = new WebSocket(details.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    const browser = new Browser(socket);
    browser.session = (await browser.send('Target.attachToTarget', { targetId: details.targetId, flatten: true })).sessionId;
    await browser.send('Page.enable'); return browser;
  }
  send(method, params = {}) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Browser command timed out')); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(this.session ? { sessionId: this.session } : {}) }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error('Browser evaluation failed'); return result.result.value;
  }
  close() { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Browser closed')); } this.pending.clear(); this.socket.close(); }
}
const root = await mkdtemp(join(tmpdir(), 'neo-p34-'));
const fake = await new FakeRfbServer().start(), viewerProvider = new HeadlessChromeProvider();
let gateway, preview, viewer;
try {
  gateway = await startGateway({ databaseFile: join(root, 'neo.sqlite'), dataDir: root, extensionsDir: join(repo, 'extensions'), mode: 'desktop' });
  const base = `http://127.0.0.1:${gateway.port}`, token = gateway.desktopToken;
  const rpc = createORPCClient(new RPCLink({ url: base, headers: { authorization: `Bearer ${token}` } }));
  const anonymous = createORPCClient(new RPCLink({ url: base }));
  await rpc.extensions.enable({ id: 'sample-ts' });
  assert.equal((await rpc.extensions.enable({ id: 'computer-vnc' })).status, 'running');
  const workspaceId = (await gateway.auth.kysely.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id;
  const scope = { kind: 'workspace', workspaceId };
  await rpc.vault.put({ scope, name: 'VNC_PASSWORD', value: 'password' });
  await rpc.vault.put({ scope, name: 'VNC_WRONG', value: 'wrong-secret-marker' });
  await rpc.vault.put({ scope: { kind: 'workspace', workspaceId: 'other-workspace' }, name: 'VNC_OTHER', value: 'password' });
  const target = `127.0.0.1:${fake.port}#VNC_PASSWORD`;
  const attach = { providerId: 'computer-vnc', target };
  await assert.rejects(anonymous.computers.attach(attach), e => e.code === 'UNAUTHORIZED');
  await assert.rejects(rpc.computers.attach({ ...attach, target: `127.0.0.1:${fake.port}#VNC_OTHER` }), e => e.code === 'BAD_REQUEST');
  assert.equal(fake.authenticated, 0, 'other workspace credentials cannot be selected');
  await assert.rejects(rpc.computers.attach({ ...attach, target: `127.0.0.1:${fake.port}#VNC_WRONG` }), error => {
    assert.equal(error.code, 'BAD_REQUEST'); assert.doesNotMatch(JSON.stringify(error) + String(error), /wrong-secret-marker|Do not forward/); return true;
  });
  await eventually(() => fake.sockets.size === 0, 'failed authentication socket cleanup');
  await rpc.computers.attach(attach);
  const capture = await rpc.computers.capture({ id: target });
  assert.equal(capture.width, 8); assert.equal(capture.height, 6);
  await rpc.computers.release({ id: target });
  await eventually(() => fake.sockets.size === 0, 'release socket cleanup');
  const port = await freePort();
  preview = spawn(process.execPath, [join(app, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: app, stdio: 'ignore', windowsHide: true });
  await eventually(async () => (await fetch(`http://127.0.0.1:${port}/computers`)).ok, 'app server');
  await viewerProvider.attach('vnc-viewer'); viewer = await Browser.open(viewerProvider.browser('vnc-viewer'));
  await viewer.send('Page.navigate', { url: `http://127.0.0.1:${port}/computers?gateway=${encodeURIComponent(base)}&token=${encodeURIComponent(token)}` });
  await eventually(() => viewer.evaluate('!!document.querySelector("[data-testid=attach-vnc]")'), 'VNC attach form');
  await viewer.evaluate(`(() => {
    for (const [label,value] of ${JSON.stringify([['VNC address', `127.0.0.1:${fake.port}`], ['VNC vault secret name', 'VNC_PASSWORD']])}) {
      const input = document.querySelector('input[aria-label="'+label+'"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);
      input.dispatchEvent(new Event('input',{bubbles:true}));
    }
  })()`);
  await eventually(() => viewer.evaluate(`(() => { const el = document.querySelector('[data-testid=attach-vnc]'); return el && !el.disabled && el.getAttribute('aria-disabled') !== 'true'; })()`), 'VNC attach enabled');
  await viewer.evaluate(`document.querySelector('[data-testid=attach-vnc]').click()`);
  await eventually(async () => (await rpc.computers.list()).some(c => c.id === target), 'UI attaches VNC desktop');
  const pixel = (x, y) => viewer.evaluate(`(() => {
    const image = document.querySelector('[data-testid=computer-frame]'); if (!image?.complete || image.naturalWidth !== 8) return null;
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d'); context.drawImage(image,0,0); return Array.from(context.getImageData(${x},${y},1,1).data);
  })()`);
  await eventually(async () => JSON.stringify(await pixel(0, 0)) === '[10,40,200,255]', 'viewer decodes expected Raw pixel');
  assert.deepEqual(await pixel(4, 2), [10, 40, 200, 255], 'viewer shows CopyRect destination');
  assert.deepEqual(await pixel(3, 3), [220, 20, 30, 255]);
  await rpc.computers.assign({ engine: 'dsh', targetId: 'scripted-vnc-bot', computerId: target });
  const binding = gateway.computers.binding('dsh', 'scripted-vnc-bot');
  const act = action => fetch(binding.endpoint, { method: 'POST', headers: { authorization: `Bearer ${binding.token}`, 'content-type': 'application/json' }, body: JSON.stringify(action) });
  assert.equal((await act({ action: 'move', x: 3, y: 3 })).status, 200);
  assert.equal((await act({ action: 'click', x: 3, y: 3 })).status, 200);
  assert.notEqual((await rpc.computers.capture({ id: target })).png, capture.png);
  await eventually(async () => JSON.stringify(await pixel(3, 3)) === '[20,210,50,255]', 'viewer reflects bot click');
  assert.equal((await act({ action: 'type', text: 'a' })).status, 200);
  assert.equal((await act({ action: 'key', keys: 'Ctrl+Left' })).status, 200);
  await eventually(async () => JSON.stringify(await pixel(0, 0)) === '[250,220,10,255]', 'viewer reflects key input');
  const notices = [], abort = new AbortController();
  const eventDeadline = setTimeout(() => abort.abort(), 3000);
  try {
    for await (const notice of gateway.kernel.events.subscribe(0, abort.signal)) {
      if (notice.type === 'computer.acting' && notice.computerId === target) notices.push(notice);
      if (notices.length === 8) { abort.abort(); break; }
    }
  } finally { clearTimeout(eventDeadline); }
  assert.deepEqual(notices.filter(n => n.active).map(n => n.action), ['move', 'click', 'type', 'key']);
  await rpc.computers.kill({ engaged: true });
  const count = fake.pointers.length;
  assert.equal((await act({ action: 'click', x: 3, y: 3 })).status, 403);
  assert.equal(fake.pointers.length, count);
  assert.equal((await rpc.computers.capture({ id: target })).width, 8, 'viewing survives kill switch');
  await rpc.computers.kill({ engaged: false });
  await rpc.computers.lease({ id: target, holder: 'human' });
  assert.equal((await act({ action: 'key', keys: 'Enter' })).status, 403);
  await rpc.computers.lease({ id: target, holder: 'agent' });
  fake.drop(); await eventually(() => fake.sockets.size === 0, 'drop socket');
  await assert.rejects(rpc.computers.capture({ id: target }), error => error.code === 'BAD_GATEWAY' && /reattach/.test(error.message));
  await eventually(() => viewer.evaluate('document.querySelector("[role=alert]")?.textContent.includes("reattach")'), 'viewer shows dropped-connection recovery');
  await rpc.computers.release({ id: target });
  await rpc.computers.attach(attach);
  await rpc.computers.assign({ engine: 'dsh', targetId: 'scripted-vnc-bot', computerId: target });
  const reconnected = gateway.computers.binding('dsh', 'scripted-vnc-bot');
  assert.notEqual(reconnected.token, binding.token);
  assert.equal((await rpc.computers.capture({ id: target })).width, 8);
  await rpc.extensions.disable({ id: 'computer-vnc' });
  await eventually(() => fake.sockets.size === 0, 'disable closes RFB socket');
  assert.ok(!(await rpc.computers.list()).some(c => c.id === target));
  assert.equal(gateway.computers.binding('dsh', 'scripted-vnc-bot'), undefined);
  assert.equal((await act({ action: 'click', x: 3, y: 3 })).status, 403, 'revoked token stays revoked');
  assert.equal((await fetch(base + '/x/sample-ts/hello', { headers: { authorization: `Bearer ${token}` } })).status, 200);
  console.log('P3-4 PASS authenticated=true vault-scoped=true wrong-password-rejected+redacted=true raw+copyrect-pixels=true viewer=true click-changes-frame=true move+type+key=true acting-events=true kill+lease-block=true drop-clear+reattach=true release+disable-sockets-closed=true siblings-healthy=true');
} finally {
  viewer?.close(); await viewerProvider.release('vnc-viewer');
  if (preview?.pid) {
    if (process.platform === 'win32') spawnSync(join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(preview.pid), '/T', '/F'], { windowsHide: true });
    else preview.kill('SIGKILL');
  }
  await gateway?.close(); await fake.close();
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '/') || resolve(root).startsWith(resolve(tmpdir()) + '\\'));
  await rm(root, { recursive: true, force: true });
}
