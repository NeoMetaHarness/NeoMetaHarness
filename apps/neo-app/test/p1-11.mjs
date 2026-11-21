import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(testDir, '..');
const repoDir = resolve(appDir, '../..');
const exe = join(appDir, 'src-tauri/target/debug/neo-meta-harness.exe');

async function eventually(fn, label, retries = 150) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

async function availablePort() {
  const server = createNetServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function openWebview(port) {
  const page = await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    return (await response.json()).find((item) => item.type === 'page' && /tauri\.localhost/.test(item.url));
  }, 'WebView2 debugging page');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!pending.has(message.id)) return;
    pending.get(message.id)(message);
    pending.delete(message.id);
  };
  const send = (method, params = {}) => new Promise((done, reject) => {
    const number = ++id;
    pending.set(number, (message) => message.error ? reject(new Error(message.error.message)) : done(message.result));
    socket.send(JSON.stringify({ id: number, method, params }));
  });
  await send('Runtime.enable');
  const evaluate = async (expression) => {
    const answer = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (answer.exceptionDetails) throw new Error(answer.result?.description ?? answer.exceptionDetails.text);
    return answer.result.value;
  };
  return {
    evaluate,
    wait: async (expression, label) => {
      try {
        return await eventually(() => evaluate(expression), label);
      } catch (error) {
        const alert = await evaluate('document.querySelector("[role=alert]")?.textContent ?? ""');
        const roleStatus = await evaluate('document.querySelector("[role=status]")?.textContent ?? ""');
        const sectionHtml = await evaluate('document.querySelector("section[aria-label=\'Desktop updates\']")?.innerHTML ?? ""');
        throw new Error(`${error.message}. UI alert: "${alert}". Status: "${roleStatus}". Section HTML: "${sectionHtml}"`);
      }
    },
    close: () => socket.close(),
  };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function closeWindow(pid) {
  const script = `$process = Get-Process -Id ${pid} -ErrorAction Stop; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CloseWindow { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp); }'; if ($process.MainWindowHandle -eq [IntPtr]::Zero -or -not [CloseWindow]::PostMessage($process.MainWindowHandle, 16, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Could not close window' }`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
}

// 1. Build frontend and tauri binary
console.log('Building frontend with Vite...');
execFileSync(process.execPath, [join(appDir, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: appDir, stdio: 'pipe' });

console.log('Running installer-check unit checks (verifying rejection of placeholder key and acceptance of valid test key)...');
const { runInstallerCheck } = await import('../../../scripts/installer-check.mjs');
const baseTauriConf = JSON.parse(await readFile(join(appDir, 'src-tauri/tauri.conf.json'), 'utf8'));

// Verify that default config with placeholder key strictly fails installer-check (no bypass)
assert.throws(
  () => runInstallerCheck(),
  /release installer packaging requires a valid owner minisign public key, not a placeholder or empty string/,
  'installer-check must reject the placeholder public key with no bypass'
);

// Verify that an empty pubkey fails installer-check
assert.throws(
  () => runInstallerCheck({
    configOverride: {
      ...baseTauriConf,
      plugins: {
        ...baseTauriConf.plugins,
        updater: {
          ...baseTauriConf.plugins?.updater,
          pubkey: '',
        },
      },
    },
  }),
  /release installer packaging requires a valid owner minisign public key/,
  'installer-check must reject an empty public key'
);

// Verify well-formed dummy test key fixture is accepted
const dummyTestKey = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkKUldUTVBERFVMWVNZTkRFUkZBS0VLRVkxMjM0NTY3ODkwMTI=';
const dummyConfig = {
  ...baseTauriConf,
  plugins: {
    ...baseTauriConf.plugins,
    updater: {
      ...baseTauriConf.plugins?.updater,
      pubkey: dummyTestKey,
    },
  },
};
runInstallerCheck({ configOverride: dummyConfig });
console.log('Installer check verification passed (placeholder rejected, test key accepted).');

console.log('Running cargo unit tests (verifying updater overrides and endpoint HTTPS enforcement)...');
execFileSync(join(process.env.USERPROFILE, '.cargo/bin/cargo.exe'), ['test'], {
  cwd: join(appDir, 'src-tauri'), stdio: 'pipe',
});

console.log('Building desktop binary with Cargo (debug)...');
execFileSync(join(process.env.USERPROFILE, '.cargo/bin/cargo.exe'), ['build'], {
  cwd: join(appDir, 'src-tauri'), stdio: 'pipe',
});

// 2. Setup mock updater server serving latest.json
let updateRequestCount = 0;
const updateServer = createServer((request, response) => {
  console.log(`Fake update server received request: ${request.method} ${request.url}`);
  if (request.url === '/latest.json') {
    updateRequestCount++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      version: '0.2.0',
      notes: 'Neo Meta Harness 0.2.0 update notes',
      pub_date: '2026-11-20T12:00:00Z',
      platforms: {
        'windows-x86_64': {
          signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQpmYWtlLXNpZ25hdHVyZQo=',
          url: `http://127.0.0.1:${updateServer.address().port}/download/neo-app-0.2.0.msi.zip`
        }
      }
    }));
    return;
  }
  response.writeHead(404).end();
});

await new Promise((done) => updateServer.listen(0, '127.0.0.1', done));
const updaterPort = updateServer.address().port;
console.log(`Fake update server listening on http://127.0.0.1:${updaterPort}`);

const home = await mkdtemp(join(tmpdir(), 'nmh-p1-11-'));
const statusFile = join(home, 'ready.json');
const cdpPort = await availablePort();

const desktop = spawn(exe, [], {
  cwd: appDir,
  stdio: 'ignore',
  windowsHide: false,
  env: {
    ...process.env,
    NMH_DESKTOP_REPO_ROOT: repoDir,
    NMH_DESKTOP_DATA_DIR: join(home, 'state'),
    NMH_HERMES_HOME: join(home, 'hermes'),
    NMH_DESKTOP_STATUS_FILE: statusFile,
    NMH_UPDATER_ENDPOINT: `http://127.0.0.1:${updaterPort}/latest.json`,
    WEBVIEW2_USER_DATA_FOLDER: join(home, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
  },
});

let view;
let status;
try {
  status = await eventually(async () => JSON.parse(await readFile(statusFile, 'utf8')), 'desktop ready file');
  const base = `http://127.0.0.1:${status.port}`;

  view = await openWebview(cdpPort);

  // Skip onboarding when presented
  await view.wait('!!document.querySelector("[data-testid=onboarding-wizard]")', 'first-run setup');
  await view.evaluate('document.querySelector("[data-testid=onboarding-skip]")?.click()');
  await view.wait('!document.querySelector("[data-testid=onboarding-wizard]")', 'onboarding dismissed');

  // Navigate to Settings
  await view.wait('!!document.querySelector("a[href*=\\"/settings\\"]")', 'settings nav link');
  await view.evaluate('document.querySelector("a[href*=\\"/settings\\"]")?.click()');
  await view.wait('!!document.querySelector("[data-testid=settings-update-check]")', 'Settings update check button');

  // Trigger check on demand
  console.log('Clicking check for updates button...');
  await view.evaluate('document.querySelector("[data-testid=settings-update-check]")?.click()');

  // Verify UI displays available version and "Install and restart" button
  await view.wait(
    'document.querySelector("[data-testid=settings-update-available]") !== null || document.body.textContent.includes("0.2.0")',
    'update available status displayed'
  );
  await view.wait(
    'document.querySelector("[data-testid=settings-update-install]") !== null',
    'Install and restart button displayed'
  );

  const text = await view.evaluate('document.body.textContent');
  assert.ok(text.includes('0.2.0'), 'UI text contains version 0.2.0');
  assert.ok(text.includes('Update available'), 'UI text contains "Update available"');
  assert.ok(text.includes('Install and restart'), 'UI text contains "Install and restart"');

  const installButton = await view.evaluate('document.querySelector("[data-testid=settings-update-install]")?.textContent');
  assert.equal(installButton?.trim(), 'Install and restart');

  assert.ok(updateRequestCount >= 1, 'Fake update server received at least one request');

  // Clean exit without executing install
  closeWindow(desktop.pid);
  await eventually(() => !alive(desktop.pid), 'desktop clean exit', 450);
  await eventually(async () => {
    try { await fetch(`${base}/health`); return false; } catch { return true; }
  }, 'gateway clean exit', 450);

  console.log('P1-11 PASS fake_update_server=true version=0.2.0 ui_shown=true install_not_executed=true clean_exit=true');
} finally {
  view?.close();
  if (alive(desktop.pid)) spawnSync('taskkill.exe', ['/PID', String(desktop.pid), '/T', '/F'], { windowsHide: true });
  if (status?.gatewayPid && alive(status.gatewayPid)) spawnSync('taskkill.exe', ['/PID', String(status.gatewayPid), '/T', '/F'], { windowsHide: true });
  await new Promise((done) => updateServer.close(done));
  await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
}
