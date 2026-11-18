import assert from 'node:assert/strict';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const gatewayDir = join(repo, 'apps', 'gateway');
const req = createRequire(join(gatewayDir, 'package.json'));
const { createORPCClient } = await import(pathToFileURL(req.resolve('@orpc/client')).href);
const { RPCLink } = await import(pathToFileURL(req.resolve('@orpc/client/fetch')).href);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function makeRng(seed) {
  let s = seed >>> 0;
  return function() {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function shuffle(array, rng) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve test port');
  await new Promise((done) => server.close(done));
  return address.port;
}

async function startFakeModel() {
  const port = await freePort();
  const server = createHttpServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
      return;
    }
    if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-fake', object: 'chat.completion', created: Date.now(),
        choices: [{ index: 0, message: { role: 'assistant', content: 'Fake model response' }, finish_reason: 'stop' }],
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  return { port, close: () => new Promise((done) => server.close(done)) };
}

function getDescendantProcesses(parentPid) {
  try {
    const raw = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
    ], { maxBuffer: 15 * 1024 * 1024, windowsHide: true }).toString();
    const procs = JSON.parse(raw);
    const byParent = new Map();
    for (const p of procs) {
      const ppid = p.ParentProcessId;
      if (!byParent.has(ppid)) byParent.set(ppid, []);
      byParent.get(ppid).push(p);
    }
    const descendants = [];
    function collect(pid) {
      const children = byParent.get(pid) || [];
      for (const child of children) {
        descendants.push(child);
        collect(child.ProcessId);
      }
    }
    collect(parentPid);
    return descendants;
  } catch {
    return [];
  }
}

async function startGateway(dbFile, hermesHome, modelUrl, testAdapter) {
  let token = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: gatewayDir,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    env: {
      ...process.env,
      NMH_DB_PATH: dbFile,
      NMH_HERMES_HOME: hermesHome,
      NMH_HERMES_MODEL_URL: modelUrl,
      NMH_EXTENSIONS_DIR: join(repo, 'extensions'),
      NMH_PORT: '0',
      NEO_MODE: 'desktop',
      NEO_PRINT_DESKTOP_TOKEN: '1',
      NODE_ENV: 'test',
      NMH_SUPERAGENT_TEST_ADAPTER: testAdapter,
      NMH_UPSTREAM_CACHE: process.env.NMH_UPSTREAM_CACHE ?? 'C:\\Users\\Neo\\Desktop\\nmh-upstream-cache',
    },
  });

  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
  const port = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gateway startup timed out: ${errors}`)), 30000);
    const lines = createInterface({ input: child.stdout });
    const success = (portNumber) => { clearTimeout(timer); lines.close(); done(portNumber); };
    const fail = (error) => { clearTimeout(timer); lines.close(); reject(error); };
    lines.on('line', (line) => {
      if (line.startsWith('NEO_DESKTOP_TOKEN ')) token = line.slice('NEO_DESKTOP_TOKEN '.length).trim();
      if (line.startsWith('GATEWAY_READY ')) {
        const payload = JSON.parse(line.slice('GATEWAY_READY '.length));
        if (payload.token) token = payload.token;
        success(payload.port);
      }
    });
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`Gateway exited ${code}: ${errors}`)));
  });

  return {
    port,
    token,
    child,
    errors: () => errors,
    async close() {
      if (child.exitCode !== null) return;
      const exit = new Promise((done) => child.once('exit', done));
      child.send('shutdown');
      await Promise.race([exit, sleep(5000)]);
      if (child.exitCode === null) {
        if (process.platform === 'win32') {
          spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      }
    },
  };
}

// Every extension in the repo is covered; a new extension can't silently escape this suite.
// Valid sample inputs for the few oRPC routes that answer a disabled extension themselves (policy first, then their own error).
const SELF_REPORTING_INPUT = {
  '/x/channels/list': { profile: 'default' }, '/x/channels/status': { profile: 'default' },
  '/x/channels/connect': { profile: 'default', platform: 'telegram', token: 'probe' },
  '/x/channels/disconnect': { profile: 'default', platform: 'telegram' },
  '/x/memory-honcho/status': {}, '/x/memory-honcho/list': {},
};
const OFFICIAL_EXTENSIONS = readdirSync(join(here, '../../extensions'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(here, '../../extensions', entry.name, 'neo.extension.json')))
  .map((entry) => entry.name)
  .sort();
// Declared dependencies (neo.extension.json dependsOn) drive enable order and expected degradation.
const MANIFEST_DEPS = Object.fromEntries(OFFICIAL_EXTENSIONS.map((id) => [id,
  Object.keys(JSON.parse(readFileSync(join(here, '../../extensions', id, 'neo.extension.json'), 'utf8')).dependsOn ?? {})]));
function dependentsOf(id) {
  const out = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [ext, deps] of Object.entries(MANIFEST_DEPS)) {
      if (!out.has(ext) && deps.some((d) => d === id || out.has(d))) { out.add(ext); grew = true; }
    }
  }
  return [...out];
}
{
  const ordered = []; const seen = new Set();
  const visit = (id) => { if (seen.has(id)) return; seen.add(id); for (const d of MANIFEST_DEPS[id] ?? []) if (MANIFEST_DEPS[d]) visit(d); ordered.push(id); };
  OFFICIAL_EXTENSIONS.forEach(visit);
  OFFICIAL_EXTENSIONS.splice(0, OFFICIAL_EXTENSIONS.length, ...ordered);
}

async function runSmokeCall(id, rpc, base, authHeaders) {
  switch (id) {
    case 'sample-ts': {
      const res = await fetch(`${base}/x/sample-ts/hello`, { headers: authHeaders });
      assert.equal(res.status, 200, `sample-ts returned ${res.status}`);
      break;
    }
    case 'sample-py': {
      const res = await fetch(`${base}/x/sample-py/hello`, { headers: authHeaders });
      assert.equal(res.status, 200, `sample-py returned ${res.status}`);
      break;
    }
    case 'engine-t3': {
      const list = await rpc.extensions.list();
      const t3 = list.find((x) => x.id === 'engine-t3');
      assert.equal(t3?.status, 'running', 'engine-t3 running');
      break;
    }
    case 'memory-local': {
      const list = await rpc.x['memory-local'].list({ workspace: 'default' });
      assert.ok(Array.isArray(list), 'memory-local list is array');
      break;
    }
    case 'skills-registry': {
      const list = await rpc.x['skills-registry'].list();
      assert.ok(Array.isArray(list), 'skills-registry list is array');
      break;
    }
    case 'engine-hermes': {
      const res = await rpc.x['engine-hermes'].profiles.list();
      assert.ok(Array.isArray(res.profiles), 'engine-hermes profiles is array');
      break;
    }
    case 'engine-superagent': {
      const items = await rpc.inbox.list();
      assert.ok(Array.isArray(items), 'engine-superagent inbox is array');
      break;
    }
    case 'engine-dsh': {
      const list = await rpc.extensions.list();
      const dsh = list.find((x) => x.id === 'engine-dsh');
      assert.equal(dsh?.status, 'running', 'engine-dsh running');
      assert.equal(dsh?.health?.ok, true, 'engine-dsh health ok');
      break;
    }
    case 'computer-fake': {
      const res = await fetch(`${base}/x/computer-fake/calls`, { headers: authHeaders });
      assert.equal(res.status, 200, `computer-fake returned ${res.status}`);
      break;
    }
    case 'computer-headless-chrome': {
      const list = await rpc.extensions.list();
      const ext = list.find((x) => x.id === 'computer-headless-chrome');
      assert.equal(ext?.status, 'running', 'computer-headless-chrome running');
      assert.equal(ext?.health?.ok, true, 'computer-headless-chrome health ok');
      break;
    }
    default: {
      // No extension-specific smoke call: require it to be running and healthy.
      const status = (await rpc.extensions.list()).find((entry) => entry.id === id);
      assert.equal(status?.status, 'running', `${id} is not running`);
      assert.notEqual(status?.health?.ok, false, `${id} reports unhealthy`);
      break;
    }
  }
}

async function verifyProjectionsClean(id, hermesHome, extDataDir) {
  if (id === 'skills-registry') {
    const hermesSkills = join(hermesHome, 'skills');
    if (existsSync(hermesSkills)) {
      const files = await readdir(hermesSkills);
      assert.equal(files.length, 0, `Leaked skills projections in ${hermesSkills}: ${files.join(', ')}`);
    }
  }
  if (id === 'engine-dsh') {
    const dshDir = join(extDataDir, 'engine-dsh');
    if (existsSync(dshDir)) {
      const entries = await readdir(dshDir);
      const activeSessions = entries.filter((e) => e.startsWith('session-'));
      assert.equal(activeSessions.length, 0, `Leaked DSH sessions in ${dshDir}: ${activeSessions.join(', ')}`);
    }
  }
}

async function verifyNoProcessLeak(id, gatewayPid) {
  for (let retry = 0; retry < 10; retry++) {
    const children = getDescendantProcesses(gatewayPid);
    let leaked = false;
    if (id === 'computer-headless-chrome') {
      leaked = children.some((p) => /chrome/i.test(p.Name));
    } else if (id === 'sample-py') {
      leaked = children.some((p) => /python|uv/i.test(p.Name) && /extension\.py/i.test(p.CommandLine || ''));
    }
    if (!leaked) return;
    await sleep(500);
  }
  const remaining = getDescendantProcesses(gatewayPid);
  throw new Error(`Process leak for ${id}: ${JSON.stringify(remaining.map((p) => p.Name))}`);
}

async function main() {
  const seed = process.env.SEED ? parseInt(process.env.SEED, 10) : Math.floor(Math.random() * 1000000);
  console.log(`P7-1 TOGGLE_SAFETY starting seed=${seed}`);
  const rng = makeRng(seed);

  const root = await mkdtemp(join(tmpdir(), 'nmh-toggle-safety-'));
  const dbFile = join(root, 'state.sqlite');
  const hermesHome = join(root, 'hermes-home');
  const extDataDir = join(root, 'extensions');
  await mkdir(hermesHome, { recursive: true });
  await mkdir(extDataDir, { recursive: true });

  const fakeModel = await startFakeModel();
  const testAdapter = new URL('../../extensions/engine-superagent/test/scripted-models.ts', import.meta.url).href;

  let gateway = await startGateway(dbFile, hermesHome, `http://127.0.0.1:${fakeModel.port}/v1`, testAdapter);

  const checks = new Map();
  for (const id of OFFICIAL_EXTENSIONS) {
    checks.set(id, {
      routes404: true,
      othersOk: true,
      noProcLeak: true,
      noProjLeak: true,
      reEnableOk: true,
    });
  }

  try {
    const authHeaders = () => ({ authorization: `Bearer ${gateway.token}` });
    const rpc = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${gateway.port}`, headers: authHeaders }));

    console.log('Enabling all official extensions for baseline...');
    for (const id of OFFICIAL_EXTENSIONS) {
      const res = await rpc.extensions.enable({ id });
      assert.equal(res.status, 'running', `Failed to enable ${id}: ${res.reason}`);
      await runSmokeCall(id, rpc, `http://127.0.0.1:${gateway.port}`, authHeaders());
    }
    console.log(`Baseline established: all ${OFFICIAL_EXTENSIONS.length} extensions running and healthy.\n`);

    const ROUNDS = 3;
    for (let round = 1; round <= ROUNDS; round++) {
      const order = shuffle(OFFICIAL_EXTENSIONS, rng);
      console.log(`--- Round ${round}/${ROUNDS} order: [${order.join(', ')}] ---`);

      for (const id of order) {
        process.stdout.write(`Testing toggle of ${id}... `);
        const listBefore = await rpc.extensions.list();
        const extBefore = listBefore.find((x) => x.id === id);
        const routes = extBefore?.routes || [];

        // 1. Disable extension
        await rpc.extensions.disable({ id });
        const listAfterDisable = await rpc.extensions.list();
        const extDisabled = listAfterDisable.find((x) => x.id === id);
        assert.equal(extDisabled?.status, 'disabled', `${id} did not disable`);

        // Check 1: Routes return 404 or disabled
        let routesPassed = true;
        for (const route of routes) {
          let res = await fetch(`http://127.0.0.1:${gateway.port}${route}`, { headers: authHeaders() });
          // oRPC procedures that report their own disabled state are POST-only: probe them properly.
          if (res.status === 405 && SELF_REPORTING_INPUT[route]) {
            res = await fetch(`http://127.0.0.1:${gateway.port}${route}`, {
              method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' },
              body: JSON.stringify({ json: SELF_REPORTING_INPUT[route] }),
            });
            const text = await res.clone().text();
            // Either an explicit "not found", or the route's own off/disabled status, never normal service.
            if (res.status === 200 && (/"off"|"disabled"/.test(text) || /"json":\s*\[\s*\]/.test(text))) res = new Response(null, { status: 404 });
          }
          if (res.status !== 404 && res.status !== 503) {
            routesPassed = false;
            console.error(`Route ${route} returned status ${res.status}`);
          }
        }
        if (!routesPassed) checks.get(id).routes404 = false;

        // Check 2: Other extensions remain healthy + smoke call
        let othersPassed = true;
        const dependents = dependentsOf(id);
        const others = OFFICIAL_EXTENSIONS.filter((other) => other !== id && !dependents.includes(other));
        for (const other of others) {
          const state = listAfterDisable.find((x) => x.id === other);
          const expectedHealth = other === 'engine-t3' ? true : state?.health?.ok;
          if (state?.status !== 'running' || !expectedHealth) {
            othersPassed = false;
            console.error(`Other extension ${other} degraded when ${id} disabled: status=${state?.status}`);
          }
          try {
            await runSmokeCall(other, rpc, `http://127.0.0.1:${gateway.port}`, authHeaders());
          } catch (err) {
            othersPassed = false;
            console.error(`Smoke call for ${other} failed: ${err.message}`);
          }
        }
        if (!othersPassed) checks.get(id).othersOk = false;

        // Check 3: No process leak
        let procPassed = true;
        try {
          await verifyNoProcessLeak(id, gateway.child.pid);
        } catch (err) {
          procPassed = false;
          console.error(err.message);
        }
        if (!procPassed) checks.get(id).noProcLeak = false;

        // Check 4: No projection leak
        let projPassed = true;
        try {
          await verifyProjectionsClean(id, hermesHome, extDataDir);
        } catch (err) {
          projPassed = false;
          console.error(err.message);
        }
        if (!projPassed) checks.get(id).noProjLeak = false;

        // Check 5: Re-enable extension
        let reEnablePassed = true;
        try {
          const reRes = await rpc.extensions.enable({ id });
          assert.equal(reRes.status, 'running', `${id} re-enable failed`);
          await runSmokeCall(id, rpc, `http://127.0.0.1:${gateway.port}`, authHeaders());
          // Dependents may have degraded while their dependency was off; they must recover.
          for (const dep of dependents) {
            const st = (await rpc.extensions.list()).find((x) => x.id === dep);
            if (st?.status !== 'running') {
              const r = await rpc.extensions.enable({ id: dep });
              assert.equal(r.status, 'running', `dependent ${dep} did not recover after ${id} re-enable`);
            }
            await runSmokeCall(dep, rpc, `http://127.0.0.1:${gateway.port}`, authHeaders());
          }
        } catch (err) {
          reEnablePassed = false;
          console.error(`Re-enable ${id} failed: ${err.message}`);
        }
        if (!reEnablePassed) checks.get(id).reEnableOk = false;

        console.log('OK');
      }
    }

    // Bulk toggle test
    console.log('\n--- Bulk toggle test: disabling everything ---');
    for (const id of [...OFFICIAL_EXTENSIONS].reverse()) {
      await rpc.extensions.disable({ id });
    }
    const allDisabled = await rpc.extensions.list();
    assert.ok(allDisabled.every((x) => x.status === 'disabled'), 'All extensions are disabled');
    console.log('Bulk disable verified. Re-enabling everything...');
    for (const id of OFFICIAL_EXTENSIONS) {
      const res = await rpc.extensions.enable({ id });
      assert.equal(res.status, 'running', `Failed bulk re-enable for ${id}`);
      await runSmokeCall(id, rpc, `http://127.0.0.1:${gateway.port}`, authHeaders());
    }
    console.log('Bulk toggle PASSED.\n');

    // Resilience test: kill gateway mid-run and restart
    console.log('--- Resilience test: kill gateway mid-run and restart ---');
    const oldPid = gateway.child.pid;
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(oldPid), '/T', '/F'], { windowsHide: true });
    } else {
      gateway.child.kill('SIGKILL');
    }
    await sleep(2000);
    const orphans = getDescendantProcesses(oldPid);
    assert.equal(orphans.length, 0, `Orphan processes left after kill: ${orphans.map((p) => p.Name).join(', ')}`);

    console.log('Restarting gateway on existing state...');
    gateway = await startGateway(dbFile, hermesHome, `http://127.0.0.1:${fakeModel.port}/v1`, testAdapter);
    const restartedRpc = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${gateway.port}`, headers: () => ({ authorization: `Bearer ${gateway.token}` }) }));
    const recoveredList = await restartedRpc.extensions.list();
    assert.ok(recoveredList.length >= OFFICIAL_EXTENSIONS.length, 'Recovered extensions list');
    console.log('Resilience test PASSED.\n');

  } finally {
    await gateway.close();
    await fakeModel.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }

  // Print Summary Table
  console.log('\n========================================================================================');
  console.log(`EXTENSION TOGGLE-SAFETY CHECK MATRIX (Seed: ${seed})`);
  console.log('========================================================================================');
  console.log(`${'Extension'.padEnd(28)} | ${'Routes 404'.padEnd(10)} | ${'Others OK'.padEnd(10)} | ${'No Proc Leak'.padEnd(12)} | ${'No Proj Leak'.padEnd(12)} | ${'Re-enable OK'.padEnd(12)}`);
  console.log('-'.repeat(88));

  let allPassed = true;
  for (const [id, res] of checks.entries()) {
    const r404 = res.routes404 ? 'PASS' : 'FAIL';
    const oth = res.othersOk ? 'PASS' : 'FAIL';
    const proc = res.noProcLeak ? 'PASS' : 'FAIL';
    const proj = res.noProjLeak ? 'PASS' : 'FAIL';
    const re = res.reEnableOk ? 'PASS' : 'FAIL';
    if (!res.routes404 || !res.othersOk || !res.noProcLeak || !res.noProjLeak || !res.reEnableOk) {
      allPassed = false;
    }
    console.log(`${id.padEnd(28)} | ${r404.padEnd(10)} | ${oth.padEnd(10)} | ${proc.padEnd(12)} | ${proj.padEnd(12)} | ${re.padEnd(12)}`);
  }
  console.log('========================================================================================\n');

  if (!allPassed) {
    console.error(`P7-1 TOGGLE_SAFETY FAILED seed=${seed}`);
    process.exit(1);
  }
  console.log(`P7-1 TOGGLE_SAFETY PASS seed=${seed}`);
}

main().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});