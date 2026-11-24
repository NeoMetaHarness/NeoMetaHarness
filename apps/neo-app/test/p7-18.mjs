import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';

async function eventually(read, description) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function luminance(color) {
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const packed = hex.length === 3 ? [...hex].map((digit) => digit.repeat(2)).join('') : hex;
    assert.match(packed, /^[\da-f]{6}$/i);
    color = [0, 2, 4].map((offset) => Number.parseInt(packed.slice(offset, offset + 2), 16));
  } else {
    assert.match(color, /^rgb\(\d+, \d+, \d+\)$/);
    color = color.match(/\d+/g).map(Number);
  }
  const [r, g, b] = color.map((channel) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function requireContrast(foreground, background, threshold, label) {
  const values = [luminance(foreground), luminance(background)];
  const ratio = (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
  assert.ok(ratio >= threshold, `${label} contrast ${ratio.toFixed(2)} below ${threshold}`);
  return ratio;
}

const surfaces = ['canvas', 'surface', 'surface-raised', 'surface-muted', 'surface-selected'];
const text = ['text', 'text-muted', 'accent', 'success', 'warning', 'danger'];
const pairs = [
  ...surfaces.flatMap((surface) => [
    ...text.map((color) => [color, surface, 4.5]),
    ['control-border', surface, 3],
    ['focus', surface, 3],
  ]),
  ...['accent', 'success', 'warning', 'danger'].map((color) => ['on-accent', color, 4.5]),
  ...['success', 'warning', 'danger'].map((color) => [color, `${color}-surface`, 4.5]),
];
const tokens = [...new Set(pairs.flatMap(([foreground, background]) => [foreground, background]))];
const app = fileURLToPath(new URL('..', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'neo-p7-18-'));
const chromeBinary = process.env.CHROME ?? (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : 'google-chrome');

let server, chrome, socket;
try {
  server = await preview({ root: app, configFile: false, preview: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const settings = `${origin}/settings?gateway=${encodeURIComponent(origin)}`;
  chrome = spawn(chromeBinary, ['--headless=new', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--disable-extensions', 'about:blank'],
  { stdio: 'ignore', windowsHide: true });
  let chromeError;
  chrome.on('error', (error) => { chromeError = error; });
  const port = await eventually(async () => {
    if (chromeError) throw chromeError;
    if (chrome.exitCode !== null) throw new Error(`Chrome exited ${chrome.exitCode}`);
    const data = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
    return Number(data.split('\n')[0]);
  }, 'Chrome DevTools port');
  const [page] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  let onLoad;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Page.loadEventFired') onLoad?.();
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, (response) => response.error ? reject(new Error(response.error.message)) : resolve(response.result));
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true });
    assert.ok(!exceptionDetails, result.description);
    return result.value;
  };
  const load = async (method, params) => {
    let timeout;
    const loaded = new Promise((resolve, reject) => {
      onLoad = resolve;
      timeout = setTimeout(() => reject(new Error('Document did not finish loading')), 15000);
    });
    try {
      await Promise.all([send(method, params), loaded]);
    } finally {
      clearTimeout(timeout);
      onLoad = undefined;
    }
  };
  const prefers = (value) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
  const modeIs = (mode) => `document.documentElement.dataset.theme === '${mode}' && getComputedStyle(document.documentElement).colorScheme === '${mode}'`;
  const radio = (label) => `Array.from(document.querySelectorAll('[aria-label="Color mode"] [role="radio"]')).find(radio => radio.textContent.trim() === '${label}')`;
  const selected = (label, mode) => eventually(
    () => evaluate(`${radio(label)}?.getAttribute('aria-checked') === 'true' && ${modeIs(mode)}`), `${label} selection in ${mode} mode`);
  const click = (label) => evaluate(`${radio(label)}.click()`);
  const canvasMatchesMeta = () => evaluate(`document.querySelector('meta[name="theme-color"]').content.toLowerCase() ===
    getComputedStyle(document.documentElement).getPropertyValue('--neo-color-canvas').trim().toLowerCase()`);

  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['*.js'] });
  await prefers('dark');
  await load('Page.navigate', { url: settings });
  await eventually(() => evaluate(`document.readyState === 'complete' && ${modeIs('dark')}`), 'system dark before the app bundle');
  assert.equal(await evaluate('document.getElementById("root").childElementCount'), 0);
  assert.equal(await evaluate('document.documentElement.dataset.astryxTheme'), 'neutral');
  assert.ok(await canvasMatchesMeta(), 'startup meta color agrees with dark CSS');

  await evaluate('localStorage.setItem("neo.appearance", "light")');
  await load('Page.reload');
  await eventually(() => evaluate(`document.readyState === 'complete' && ${modeIs('light')}`), 'saved light before the app bundle');
  assert.ok(await canvasMatchesMeta(), 'startup meta color agrees with light CSS');
  console.log('P7-18 BOOTSTRAP PASS app_bundle_blocked=true system_dark=true saved_light=true pwa_meta_matches=true');

  await send('Network.setBlockedURLs', { urls: [] });
  await load('Page.reload');
  await selected('Light', 'light');
  for (const mode of ['light', 'dark']) {
    if (mode === 'dark') {
      await click('Dark');
      await selected('Dark', 'dark');
    }
    assert.ok(await canvasMatchesMeta(), `PWA theme color follows ${mode}`);
    const palette = await evaluate(`Object.fromEntries(${JSON.stringify(tokens)}.map(token => [
      token, getComputedStyle(document.documentElement).getPropertyValue('--neo-color-' + token).trim()
    ]))`);
    const ratios = pairs.map(([foreground, background, threshold]) =>
      requireContrast(palette[foreground], palette[background], threshold, `${mode} ${foreground}/${background}`));
    assert.equal(await evaluate(`getComputedStyle(${radio('Dark')}).getPropertyValue('--color-accent').trim()`), palette.accent);
    const segment = await eventually(() => evaluate(`(() => {
      const active = getComputedStyle(${radio(mode === 'light' ? 'Light' : 'Dark')});
      const inactive = getComputedStyle(${radio('System')});
      const group = getComputedStyle(document.querySelector('[aria-label="Color mode"]'));
      if (!active.backgroundColor.startsWith('rgb(')) return null;
      return { activeText: active.color, activeBackground: active.backgroundColor,
        inactiveText: inactive.color, groupBackground: group.backgroundColor };
    })()`), `${mode} selection animation to settle`);
    requireContrast(segment.activeText, segment.activeBackground, 4.5, `${mode} selected appearance control`);
    requireContrast(segment.inactiveText, segment.groupBackground, 4.5, `${mode} unselected appearance control`);
    console.log(`P7-18 CONTRAST PASS mode=${mode} pairs=${pairs.length + 2} min_token_ratio=${Math.min(...ratios).toFixed(2)}`);
  }

  await load('Page.reload');
  await selected('Dark', 'dark');
  await prefers('light');
  await selected('Dark', 'dark');
  await click('System');
  await selected('System', 'light');
  await prefers('dark');
  await selected('System', 'dark');
  assert.ok(await canvasMatchesMeta(), 'runtime system change updates PWA theme color');
  assert.equal(await evaluate('localStorage.getItem("neo.appearance")'), 'system');
  console.log('P7-18 SETTINGS PASS system_light_dark=true persisted=true follows_os=true pwa_meta_matches=true');

  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.appearanceCalls = [];
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => window.appearanceCalls.push({ command, args }) };
  ` });
  await load('Page.navigate', { url: `${origin}/?setup=1&gateway=${encodeURIComponent(origin)}` });
  for (const mode of ['dark', 'light']) {
    await prefers(mode);
    const args = await eventually(() => evaluate(`window.appearanceCalls?.filter(call => call.command === 'set_window_appearance').at(-1)?.args?.mode === '${mode}' &&
      window.appearanceCalls.filter(call => call.command === 'set_window_appearance').at(-1).args`), `native ${mode} appearance`);
    const canvas = await evaluate('document.querySelector(\'meta[name="theme-color"]\').content');
    assert.equal('#' + args.background.map((channel) => channel.toString(16).padStart(2, '0')).join(''), canvas);
  }
  console.log('P7-18 DESKTOP BRIDGE PASS setup=true mode_and_background=true');
  console.log('P7-18 PASS');
} finally {
  socket?.close();
  if (chrome?.pid) {
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(chrome.pid), '/T', '/F'], { windowsHide: true });
    else chrome.kill();
  }
  await server?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
}
