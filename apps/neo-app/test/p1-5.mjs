import { existsSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

if (process.platform !== 'win32') throw new Error('P1-5 WebView2 exit test requires Windows');
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(appDir, '../..');
const exe = join(appDir, 'src-tauri/target/release/neo-meta-harness.exe');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function run(exe, args, options = {}) {
  console.log(`RUN ${exe} ${args.join(' ')}`);
  execFileSync(exe, args, { stdio: 'inherit', ...options });
}

async function availablePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function eventually(check, description, tries = 150) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const value = await check();
      if (value) return value;
    } catch { /* still starting */ }
    await sleep(100);
  }
  throw new Error(`Timed out awaiting ${description}`);
}

async function openWebview(port) {
  const page = await eventually(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return pages.find((entry) => entry.type === 'page' && /tauri\.localhost/.test(entry.url));
  }, 'WebView2 debugging page');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  let requestId = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  const send = (method, params = {}) => new Promise((done, reject) => {
    const id = ++requestId;
    pending.set(id, (message) => message.error ? reject(new Error(`${method}: ${message.error.message}`)) : done(message.result));
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.result?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  return {
    evaluate,
    eventually: (expression, description) => eventually(() => evaluate(expression), description),
    close: () => socket.close(),
  };
}

function descendants(pid) {
  const script = `$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name); $ids = @(${pid}); do { $count = $ids.Count; $ids = @($ids + @($all | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object ProcessId) | Select-Object -Unique) } while ($ids.Count -gt $count); @($all | Where-Object { $ids -contains $_.ProcessId }) | ConvertTo-Json -Compress`;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
  return [JSON.parse(output)].flat();
}

function closeWindow(pid) {
  const script = `$process = Get-Process -Id ${pid} -ErrorAction Stop; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class WindowClose { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp); }'; if ($process.MainWindowHandle -eq [IntPtr]::Zero -or -not [WindowClose]::PostMessage($process.MainWindowHandle, 16, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Could not request window close' }`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function trial(number) {
  const directory = await mkdtemp(join(tmpdir(), `nmh-p1-5-${number}-`));
  const statusFile = join(directory, 'ready.json');
  const cdpPort = await availablePort();
  let processTree = [];
  let status;
  let view;
  const desktop = spawn(exe, [], {
    cwd: appDir,
    stdio: 'ignore',
    windowsHide: false,
    env: {
      ...process.env,
      NMH_DESKTOP_REPO_ROOT: repoDir,
      NMH_DESKTOP_DATA_DIR: join(directory, 'state'),
      NMH_DESKTOP_STATUS_FILE: statusFile,
      WEBVIEW2_USER_DATA_FOLDER: join(directory, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    },
  });
  try {
    status = await eventually(async () => JSON.parse(await readFile(statusFile, 'utf8')), 'Tauri gateway readiness', 250);
    assert.equal(status.appPid, desktop.pid);
    const base = `http://127.0.0.1:${status.port}`;
    const token = (await eventually(async () => {
      const text = await readFile(join(directory, 'state', 'desktop.token'), 'utf8');
      return text.trim() || undefined;
    }, 'desktop.token file')).trim();
    assert.equal((await fetch(`${base}/x/sample-ts/hello`, { headers: { authorization: `Bearer ${token}` } })).status, 404);

    // Rows = extensions the gateway discovers (every extensions/*/neo.extension.json), not a fixed number.
    const expectedRows = readdirSync(join(repoDir, 'extensions')).filter((name) => existsSync(join(repoDir, 'extensions', name, 'neo.extension.json'))).length;
    view = await openWebview(cdpPort);
    await view.eventually(`document.querySelectorAll("[data-testid^=extension-]").length === ${expectedRows}`, `${expectedRows} extension rows`);
    await view.eventually('document.querySelector(".connection")?.textContent === "Live"', 'live event stream');
    assert.equal(await view.evaluate('"__TAURI_INTERNALS__" in window'), true, 'Tauri shell must be detected');
    assert.equal(await view.evaluate('navigator.serviceWorker.getRegistrations().then((items) => items.length)'), 0, 'no service worker');

    await view.evaluate('document.querySelector("[data-testid=extension-sample-ts] input[type=checkbox]").click()');
    await view.eventually('document.querySelector("[data-testid=extension-sample-ts] input[type=checkbox]")?.checked === true', 'TS enabled');
    assert.equal((await fetch(`${base}/x/sample-ts/hello`, { headers: { authorization: `Bearer ${token}` } })).status, 200);

    await view.evaluate('document.querySelector("[data-testid=extension-sample-py] input[type=checkbox]").click()');
    await view.eventually('document.querySelector("[data-testid=extension-sample-py] input[type=checkbox]")?.checked === true', 'Python enabled');
    assert.equal((await fetch(`${base}/x/sample-py/hello`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
    processTree = descendants(desktop.pid);
    assert.ok(processTree.some((entry) => entry.ProcessId === status.gatewayPid && /node/i.test(entry.Name)), 'Node gateway tracked');
    assert.ok(processTree.some((entry) => /python/i.test(entry.Name)), 'Python worker tracked');

    await view.evaluate('document.querySelector("[data-testid=extension-sample-ts] input[type=checkbox]").click()');
    await view.eventually('document.querySelector("[data-testid=extension-sample-ts] input[type=checkbox]")?.checked === false', 'TS disabled');
    assert.equal((await fetch(`${base}/x/sample-ts/hello`, { headers: { authorization: `Bearer ${token}` } })).status, 404);
    assert.equal((await fetch(`${base}/x/sample-py/hello`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
    await view.evaluate('document.querySelector("[data-testid=extension-sample-ts] input[type=checkbox]").click()');
    await view.eventually('document.querySelector("[data-testid=extension-sample-ts] input[type=checkbox]")?.checked === true', 'TS reenabled');
    assert.equal((await fetch(`${base}/x/sample-ts/hello`, { headers: { authorization: `Bearer ${token}` } })).status, 200);

    closeWindow(desktop.pid);
    await eventually(() => !alive(desktop.pid), 'desktop exit');
    await eventually(() => processTree.every((entry) => !alive(entry.ProcessId)), 'gateway and Python exit');
    await assert.rejects(fetch(`${base}/x/sample-ts/hello`), 'gateway port should be closed');
    console.log(`P1-5_WEBVIEW PASS trial=${number} rows=${expectedRows} live=true off=404 on=200 python=200 sw=0 process_tree=${processTree.length} clean_exit=true`);
  } finally {
    view?.close();
    if (alive(desktop.pid)) spawnSync('taskkill.exe', ['/PID', String(desktop.pid), '/T', '/F'], { windowsHide: true });
    if (status && alive(status.gatewayPid)) spawnSync('taskkill.exe', ['/PID', String(status.gatewayPid), '/T', '/F'], { windowsHide: true });
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
  }
}

run(process.execPath, [join(appDir, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: appDir });
const cargo = join(process.env.USERPROFILE, '.cargo/bin/cargo.exe');
run(cargo, ['build', '--release'], { cwd: join(appDir, 'src-tauri') });
for (let number = 1; number <= 2; number++) await trial(number);
console.log('P1-5_EXIT PASS WebView2=2/2 gateway=clean Python=clean service_worker=off');
