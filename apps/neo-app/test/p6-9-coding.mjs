import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '../..');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const { build: bundle } = createRequire(join(repo, 'extensions/engine-t3/package.json'))('esbuild');

function upstreamCache() {
  if (process.env.NMH_UPSTREAM_CACHE) return process.env.NMH_UPSTREAM_CACHE;
  for (let location = repo; ; location = dirname(location)) {
    const candidate = join(location, 'nmh-upstream-cache');
    if (existsSync(candidate)) return candidate;
    if (dirname(location) === location) throw new Error('nmh-upstream-cache not found; set NMH_UPSTREAM_CACHE');
  }
}
const ref = JSON.parse(readFileSync(join(repo, 'upstream.lock.json'), 'utf8')).pins.t3code.ref;
const upstream = join(upstreamCache(), 't3code@' + ref);
const t3Exe = join(process.env.LOCALAPPDATA ?? '', 'Programs/t3code/T3 Code (Beta).exe');
const t3Archive = join(process.env.LOCALAPPDATA ?? '', 'Programs/t3code/resources/server.asar');
const t3Entry = join(t3Archive, 'apps/server/dist/bin.mjs');
// Electron resolves paths inside server.asar even though they are not physical files.
assert.ok(existsSync(t3Exe) && existsSync(t3Archive),
  'isolated T3 test needs the installed desktop CLI');
// The isolated fake provider inherits only the OS environment needed for child processes.
const allowedEnv = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
  'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'PROCESSOR_ARCHITECTURE',
]);
const cleanEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => allowedEnv.has(name.toUpperCase())));

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function eventually(check, label, ms = 50000) {
  let problem;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (await check()) return; }
    catch (error) { problem = error; }
    await pause(120);
  }
  throw new Error(label + ' timed out: ' + String(problem ?? ''));
}
async function capture(child) {
  return new Promise((done, reject) => {
    let output = '';
    let errors = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { errors += chunk.toString().slice(0, 5000); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? done(output.trim()) : reject(new Error('T3 command failed ' + code + ': ' + errors)));
  });
}
function spawnT3(args, state) {
  return spawn(t3Exe, [t3Entry, ...args], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...cleanEnv, ELECTRON_RUN_AS_NODE: '1', T3CODE_DESKTOP_CLI_LAUNCHER: '1', T3CODE_HOME: state },
  });
}
async function waitT3(url, child) {
  await eventually(async () => {
    assert.equal(child.exitCode, null, 'isolated T3 process exited');
    try {
      const response = await fetch(url + '/api/auth/websocket-ticket', {
        method: 'POST', signal: AbortSignal.timeout(1200),
      });
      return response.status === 401 || response.status === 403;
    } catch { return false; }
  }, 'isolated T3 readiness', 25000);
}
async function pinnedSetup(temp, url, session, providerId, projectId) {
  const entry = join(repo, 'extensions/coding-workflow/test/wire.entry.ts');
  const output = join(temp, 'pinned-wire.bundle.mjs');
  await bundle({
    entryPoints: [entry], outfile: output, bundle: true, platform: 'node',
    target: 'node22', format: 'esm', nodePaths: [join(repo, 'extensions/engine-t3/node_modules')],
    plugins: [{
      name: 'pinned-t3-contracts',
      setup(builder) {
        const paths = {
          '@t3tools/contracts': 'packages/contracts/src/index.ts',
          '@t3tools/contracts/relay': 'packages/contracts/src/relay.ts',
          '@t3tools/client-runtime/rpc-protocol': 'packages/client-runtime/src/rpc/protocol.ts',
        };
        builder.onResolve({ filter: /^@t3tools\// }, (args) =>
          paths[args.path] ? { path: join(upstream, paths[args.path]) } : undefined);
      },
    }],
  });
  const script = spawn(process.execPath, [output], {
    windowsHide: true, cwd: join(repo, 'extensions/engine-t3'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...cleanEnv, T3_TEST_URL: url, T3_TEST_SESSION: session,
      T3_TEST_PROVIDER: providerId, T3_TEST_PROJECT: projectId,
      T3_TEST_WORKSPACE: join(temp, 'workspace'),
      T3_TEST_FAKE_ACP: join(repo, 'extensions/coding-workflow/test/second-acp.mjs'),
    },
  });
  const result = await capture(script);
  assert.match(result, /T3_ISOLATED_SETUP PASS/);
  assert.match(result, /P5-5_WIRE PASS/);
  console.log('P5-5_PINNED_WIRE PASS config=true switch=true worktree=true terminal=true');
}
export async function startCodingFixture(temp) {
  const state = join(temp, 't3-state');
  const port = await freePort(); const url = 'http://127.0.0.1:' + port;
  const server = spawnT3(['serve', '--mode', 'desktop', '--host', '127.0.0.1', '--port', String(port), '--base-dir', state, '--no-browser'], state);
  const close = async () => {
    if (server.exitCode !== null) return;
    const exited = new Promise(done => server.once('exit', done));
    if (process.platform === 'win32') spawnSync(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else server.kill('SIGKILL');
    await exited;
  };
  try {
    await waitT3(url, server);
    const session = await capture(spawnT3(['auth', 'session', 'issue', '--base-dir', state,
      '--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--scope', 'providers:manage',
      '--scope', 'terminal:read', '--scope', 'terminal:operate', '--scope', 'filesystem:read', '--scope', 'source-control:write',
      '--ttl', '15m', '--label', 'nmh-p69-isolated', '--token-only'], state));
    const projectId = randomUUID();
    await pinnedSetup(temp, url, session, 'p69-scripted-second', projectId);
    const root = join(temp, 'workspace');
    const git = args => { const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
    git(['init', '-b', 'main']); git(['config', 'user.name', 'Neo test']); git(['config', 'user.email', 'test@localhost']);
    await writeFile(join(root, 'README.md'), 'Isolated P6-9 repository\n'); git(['add', 'README.md']); git(['commit', '-m', 'initial']);
    return { root, projectId, env: { NMH_T3_URL: url, NMH_T3_SCOPED_SESSION: session }, close };
  } catch (error) { await close(); throw error; }
}
