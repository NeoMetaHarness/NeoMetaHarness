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
  () => runInstallerCheck({ ignoreEnv: true }),
  /release installer packaging requires a valid owner minisign public key, not a placeholder or empty string/,
  'installer-check must reject the placeholder public key with no bypass'
);

// Verify that an empty pubkey fails installer-check
assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: {
      plugins: {
        updater: {
          pubkey: '',
        },
      },
    },
  }),
  /release installer packaging requires a valid owner minisign public key/,
  'installer-check must reject an empty public key'
);

// Test fixtures for Minisign public key validation
// Valid 42-byte Minisign public key fixture (outer base64 of 2-line minisign pubkey file, line 2 decodes to 'Ed' + 8-byte id + 32-byte key)
const dummyTestKey = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkKUldSVVJWTlVTMFZaTVZwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGEK';
// Structurally malformed key: surface-valid base64 (>40 chars) but not a minisign file
const malformedSurfaceKey = Buffer.from('this is a surface-valid base64 string that is not a minisign key at all').toString('base64');
// Structurally malformed key: line 2 algorithm is 'XX' instead of 'Ed'
const badAlgKey = 'dW50cnVzdGVkIGNvbW1lbnQ6IHRlc3QKV0ZoVVJWTlVTMFZaTVZwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGEK';
// Structurally malformed key: line 2 length is 32 bytes instead of 42 bytes
const badLenKey = 'dW50cnVzdGVkIGNvbW1lbnQ6IHRlc3QKV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdsbz0K';
// Structurally malformed key: contains a third line
const thirdLineKey = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkKUldSVVJWTlVTMFZaTVZwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGEKZXh0cmEgdGhpcmQgbGluZQo=';
// Structurally malformed key: outer base64 decodes to invalid UTF-8 bytes
const invalidUtf8Key = '//79/A==';
const dummyConfig = {
  plugins: {
    updater: {
      pubkey: dummyTestKey,
    },
  },
};
runInstallerCheck({ configOverride: dummyConfig, ignoreEnv: true });

// Verify that TAURI_CONFIG in environment is merged and validated
process.env.TAURI_CONFIG = JSON.stringify({
  plugins: {
    updater: {
      pubkey: dummyTestKey,
    },
  },
});
runInstallerCheck();
delete process.env.TAURI_CONFIG;

// Verify that TAURI_CONFIG with placeholder key fails
process.env.TAURI_CONFIG = JSON.stringify({
  plugins: {
    updater: {
      pubkey: 'REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY',
    },
  },
});
assert.throws(
  () => runInstallerCheck(),
  /release installer packaging requires a valid owner minisign public key/,
  'installer-check must reject placeholder passed via TAURI_CONFIG'
);
delete process.env.TAURI_CONFIG;

// Verify that CLI --config argument override is merged and validated
runInstallerCheck({
  ignoreEnv: true,
  cliArgs: ['--config', JSON.stringify({ plugins: { updater: { pubkey: dummyTestKey } } })],
});
// Verify that structurally malformed keys fail installer-check
assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: malformedSurfaceKey } } },
  }),
  /Minisign public key file must/i,
  'installer-check must reject surface-valid base64 key lacking minisign file structure'
);

assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: badAlgKey } } },
  }),
  /algorithm ID must be "Ed"/i,
  'installer-check must reject key with wrong algorithm ID'
);

assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: badLenKey } } },
  }),
  /must decode to exactly 42 bytes/i,
  'installer-check must reject key line 2 with wrong byte length'
);

assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: thirdLineKey } } },
  }),
  /must have exactly 2 lines/i,
  'installer-check must reject key with a third line'
);

assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: invalidUtf8Key } } },
  }),
  /not valid UTF-8/i,
  'installer-check must reject key containing invalid UTF-8 bytes'
);

// Verify unrelated plugin override in TAURI_CONFIG leaves updater config intact (still failing on base placeholder)
process.env.TAURI_CONFIG = JSON.stringify({
  plugins: {
    unrelatedPlugin: { enabled: true },
  },
});
assert.throws(
  () => runInstallerCheck(),
  /release installer packaging requires a valid owner minisign public key/,
  'installer-check must retain updater config and reject base placeholder when unrelated plugin is configured'
);
delete process.env.TAURI_CONFIG;

// Verify unrelated plugin override + valid updater key succeeds
process.env.TAURI_CONFIG = JSON.stringify({
  plugins: {
    unrelatedPlugin: { enabled: true },
    updater: { pubkey: dummyTestKey },
  },
});
runInstallerCheck();
delete process.env.TAURI_CONFIG;

console.log('Installer check verification passed (effective config merging, placeholder rejected, structural validation enforced, test key accepted).');

console.log('Running cargo unit tests (verifying updater overrides and endpoint HTTPS enforcement)...');
execFileSync(join(process.env.USERPROFILE, '.cargo/bin/cargo.exe'), ['test'], {
  cwd: join(appDir, 'src-tauri'), stdio: 'pipe',
});

console.log('Testing release build fail-closed validation in build.rs...');
const cargoBin = join(process.env.USERPROFILE, '.cargo/bin/cargo.exe');
const srcTauriDir = join(appDir, 'src-tauri');

// 1. Verify cargo check --release FAILS when TAURI_CONFIG has invalid/unresolvable JSON
assert.throws(
  () => execFileSync(cargoBin, ['check', '--release'], {
    cwd: srcTauriDir,
    stdio: 'pipe',
    env: { ...process.env, TAURI_CONFIG: 'invalid-non-json' },
  }),
  /failed to run custom build command|Release build failed closed|exit code/i,
  'release cargo check must fail closed when TAURI_CONFIG is unresolvable JSON'
);

// 2. Verify cargo check --release FAILS when config has missing/empty pubkey
assert.throws(
  () => execFileSync(cargoBin, ['check', '--release'], {
    cwd: srcTauriDir,
    stdio: 'pipe',
    env: { ...process.env, TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: '' } } }) },
  }),
  /failed to run custom build command|Release build failed closed|exit code/i,
  'release cargo check must fail closed when updater pubkey is empty'
);

// 3. Verify cargo check --release FAILS with default placeholder key (no config override provided)
assert.throws(
  () => execFileSync(cargoBin, ['check', '--release'], {
    cwd: srcTauriDir,
    stdio: 'pipe',
    env: { ...process.env, TAURI_CONFIG: undefined, TAURI_ENV_CONFIG: undefined },
  }),
  /failed to run custom build command|Release build failed closed|exit code/i,
  'release cargo check must fail closed when building with placeholder key'
);

// 4. Verify cargo check --release FAILS when key is surface-valid base64 but structurally malformed
assert.throws(
  () => execFileSync(cargoBin, ['check', '--release'], {
    cwd: srcTauriDir,
    stdio: 'pipe',
    env: { ...process.env, TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: malformedSurfaceKey } } }) },
  }),
  /failed to run custom build command|Release build failed closed|exit code/i,
  'release cargo check must fail closed when key lacks minisign structure'
);

// 5. Verify cargo check --release FAILS when key has wrong algorithm ID
assert.throws(
  () => execFileSync(cargoBin, ['check', '--release'], {
    cwd: srcTauriDir,
    stdio: 'pipe',
    env: { ...process.env, TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: badAlgKey } } }) },
  }),
  /failed to run custom build command|Release build failed closed|exit code/i,
  'release cargo check must fail closed when key algorithm is not Ed'
);

// 5b. Verify cargo check --release FAILS when key has a third line
assert.throws(
  () => execFileSync(cargoBin, ['check', '--release'], {
    cwd: srcTauriDir,
    stdio: 'pipe',
    env: { ...process.env, TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: thirdLineKey } } }) },
  }),
  /failed to run custom build command|Release build failed closed|exit code/i,
  'release cargo check must fail closed when key has a third line'
);

// 5c. Verify cargo check --release FAILS when key has invalid UTF-8 bytes
assert.throws(
  () => execFileSync(cargoBin, ['check', '--release'], {
    cwd: srcTauriDir,
    stdio: 'pipe',
    env: { ...process.env, TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: invalidUtf8Key } } }) },
  }),
  /failed to run custom build command|Release build failed closed|exit code/i,
  'release cargo check must fail closed when key has invalid UTF-8 bytes'
);

// 6. Verify cargo check --release FAILS when TAURI_CONFIG only sets unrelated plugin (updater retained, base placeholder rejected)
assert.throws(
  () => execFileSync(cargoBin, ['check', '--release'], {
    cwd: srcTauriDir,
    stdio: 'pipe',
    env: { ...process.env, TAURI_CONFIG: JSON.stringify({ plugins: { unrelatedPlugin: { enabled: true } } }) },
  }),
  /failed to run custom build command|Release build failed closed|exit code/i,
  'release cargo check must fail closed when unrelated plugin is overridden without replacing placeholder pubkey'
);

// 7. Verify cargo check --release SUCCEEDS when unrelated plugin AND valid test key are supplied
execFileSync(cargoBin, ['check', '--release'], {
  cwd: srcTauriDir,
  stdio: 'pipe',
  env: {
    ...process.env,
    TAURI_CONFIG: JSON.stringify({ plugins: { unrelatedPlugin: { enabled: true }, updater: { pubkey: dummyTestKey } } }),
  },
});

// 8. Verify cargo check --release SUCCEEDS when valid test key is supplied via TAURI_CONFIG
execFileSync(cargoBin, ['check', '--release'], {
  cwd: srcTauriDir,
  stdio: 'pipe',
  env: {
    ...process.env,
    TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: dummyTestKey } } }),
  },
});
console.log('PASS build.rs release fail-closed verification (unresolvable config, placeholder, malformed keys, and unrelated plugin override verified; valid test config passes)');

console.log('Building desktop binary with Cargo (debug)...');
execFileSync(join(process.env.USERPROFILE, '.cargo/bin/cargo.exe'), ['build'], {
  cwd: join(appDir, 'src-tauri'), stdio: 'pipe',
});

// 2. Setup mock updater server serving latest.json and redirects
let updateRequestCount = 0;
let redirectFollowedCount = 0;
const updateServer = createServer((request, response) => {
  console.log(`Fake update server received request: ${request.method} ${request.url}`);
  if (request.url === '/latest-redirect') {
    redirectFollowedCount++;
    response.writeHead(302, { Location: `http://127.0.0.1:${updateServer.address().port}/latest.json` });
    response.end();
    return;
  }
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
          url: `http://127.0.0.1:${updateServer.address().port}/download/redirect`
        }
      }
    }));
    return;
  }
  if (request.url === '/download/redirect') {
    redirectFollowedCount++;
    response.writeHead(302, { Location: `http://127.0.0.1:${updateServer.address().port}/download/neo-app-0.2.0.msi.zip` });
    response.end();
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
    NMH_UPDATER_ENDPOINT: `http://127.0.0.1:${updaterPort}/latest-redirect`,
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

  assert.ok(redirectFollowedCount >= 1, 'Fake update server redirect chain followed');
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
