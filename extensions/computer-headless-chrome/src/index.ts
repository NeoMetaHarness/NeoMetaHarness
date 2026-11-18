import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { defineExtension } from '@neometaharness/kernel';
import type { Computer, ComputerInput, ComputerProvider, ComputerRegistry, Capture } from '@neometaharness/computers';

interface Pending {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const chromeBinary = () => process.env.NMH_CHROME ?? process.env.CHROME ??
  (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome');

function terminateTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

class Cdp {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as { id?: number; result?: any; error?: { message: string } };
      const pending = message.id === undefined ? undefined : this.pending.get(message.id);
      if (message.id === undefined || !pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result ?? {});
    });
    socket.on('close', () => this.failAll(new Error('Chrome disconnected')));
    socket.on('error', (error) => this.failAll(error));
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Chrome disconnected'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP command timed out: ' + method));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close(): void {
    this.socket.close();
    this.failAll(new Error('Chrome disconnected'));
  }
}

interface ChromeInstance {
  computer: Computer;
  pid: number;
  stop(): Promise<void>;
}

async function launchChrome(): Promise<ChromeInstance> {
  const profile = await mkdtemp(join(tmpdir(), 'nmh-chrome-'));
  const child = spawn(chromeBinary(), [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', '--no-proxy-server', '--window-size=1100,760',
    '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let launchError: Error | undefined;
  child.on('error', (error) => { launchError = error; });
  let cdp: Cdp | undefined;
  try {
    let port = 0;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error('Chrome exited before CDP startup');
      try {
        port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]);
        if (port) break;
      } catch { /* Browser is starting. */ }
      await pause(100);
    }
    if (!port) throw new Error('Chrome CDP startup timed out');
    const endpoint = 'http://127.0.0.1:' + port;
    const version = await (await fetch(endpoint + '/json/version')).json() as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Chrome CDP socket timed out')), 10000);
      socket.once('open', () => { clearTimeout(timeout); resolve(); });
      socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
    });
    cdp = new Cdp(socket);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method: string, params: object = {}) => cdp!.send(method, params, sessionId);
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1100, height: 700, deviceScaleFactor: 1, mobile: false,
    });

    const key = async (keys: string) => {
      const parts = keys.toUpperCase().split('+').map((part) => part.trim());
      const modifiers = (parts.includes('CTRL') || parts.includes('CONTROL') ? 2 : 0) |
        (parts.includes('ALT') ? 1 : 0) | (parts.includes('SHIFT') ? 8 : 0) |
        (parts.includes('META') ? 4 : 0);
      const name = parts.at(-1) ?? '';
      const special: Record<string, [string, string, number]> = {
        ENTER: ['Enter', 'Enter', 13], TAB: ['Tab', 'Tab', 9],
        ESC: ['Escape', 'Escape', 27], ESCAPE: ['Escape', 'Escape', 27],
        BACKSPACE: ['Backspace', 'Backspace', 8], DELETE: ['Delete', 'Delete', 46],
        LEFT: ['ArrowLeft', 'ArrowLeft', 37], RIGHT: ['ArrowRight', 'ArrowRight', 39],
      };
      const selection = special[name] ??
        (name.length === 1 ? [name.toLowerCase(), 'Key' + name, name.charCodeAt(0)] : undefined);
      if (!selection) throw new Error('Unsupported key: ' + keys);
      const [keyName, code, windowsVirtualKeyCode] = selection;
      const params = { key: keyName, code, windowsVirtualKeyCode, modifiers };
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
    };

    const computer: Computer = {
      screen: () => ({ protocol: 'png' }),
      lease: () => {},
      browser: () => ({ endpoint, webSocketDebuggerUrl: version.webSocketDebuggerUrl, targetId }),
      capture: async (): Promise<Capture> => {
        const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const png = Buffer.from(data, 'base64');
        if (png.subarray(1, 4).toString('ascii') !== 'PNG') throw new Error('Invalid Chrome PNG');
        return { png: data, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
      },
      input: async (action: ComputerInput) => {
        if (action.action === 'move') {
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: action.x, y: action.y });
        } else if (action.action === 'click') {
          await send('Input.dispatchMouseEvent', {
            type: 'mousePressed', x: action.x, y: action.y, button: 'left', clickCount: 1,
          });
          await send('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: action.x, y: action.y, button: 'left', clickCount: 1,
          });
        } else if (action.action === 'type') {
          await send('Input.insertText', { text: action.text });
        } else if (action.action === 'key') {
          await key(action.keys);
        } else if (action.action === 'scroll') {
          const direction = action.direction.toLowerCase();
          if (!['up', 'down', 'left', 'right'].includes(direction) || action.amount < 0) {
            throw new Error('Unsupported scroll');
          }
          const distance = Math.min(action.amount, 10000);
          await send('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: 550, y: 350,
            deltaY: direction === 'up' ? -distance : direction === 'down' ? distance : 0,
            deltaX: direction === 'left' ? -distance : direction === 'right' ? distance : 0,
          });
        }
      },
    };
    return {
      computer, pid: child.pid!,
      async stop() {
        cdp?.close();
        terminateTree(child);
        await rm(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
      },
    };
  } catch (error) {
    cdp?.close();
    terminateTree(child);
    await rm(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 }).catch(() => {});
    throw error;
  }
}

export class HeadlessChromeProvider implements ComputerProvider {
  readonly capabilities = {
    screen: true, input: true, browserCdp: true, shell: false, files: false, snapshot: false,
  };
  private readonly instances = new Map<string, ChromeInstance>();
  private readonly starting = new Set<string>();

  provision(spec: Record<string, unknown>): Promise<Computer> {
    return this.attach(String(spec.id ?? 'headless-chrome'));
  }

  async attach(target: string): Promise<Computer> {
    if (this.instances.has(target) || this.starting.has(target)) throw new Error('Computer already exists');
    this.starting.add(target);
    try {
      const instance = await launchChrome();
      this.instances.set(target, instance);
      return instance.computer;
    } finally {
      this.starting.delete(target);
    }
  }

  pid(id: string): number | undefined { return this.instances.get(id)?.pid; }
  browser(id: string): unknown { return this.instances.get(id)?.computer.browser?.(); }

  async release(id: string): Promise<void> {
    const instance = this.instances.get(id);
    this.instances.delete(id);
    await instance?.stop();
  }

  async dispose(): Promise<void> {
    const ids = [...this.instances.keys()];
    await Promise.all(ids.map((id) => this.release(id)));
  }
}

export default defineExtension({
  activate(ctx) {
    const computers = ctx.inject<ComputerRegistry>('computers');
    if (!computers) throw new Error('Missing computer registry');
    const provider = new HeadlessChromeProvider();
    const unregister = computers.registerProvider('computer-headless-chrome', provider);
    ctx.effect(() => async () => {
      await unregister();
      await provider.dispose();
    });
    ctx.health(() => ({ ok: true }));
  },
});
