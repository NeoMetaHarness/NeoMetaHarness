import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const root = resolve(import.meta.dirname);
const state = await mkdtemp(join(tmpdir(), 'nmh-dsh-sdk-'));
const cwd = join(state, 'workspace');
await mkdir(cwd);
const cli = resolve(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
// The profile is isolated; bare package names resolve from DSH_HOME, not our package root.
let patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
for (const pkg of ['@deepseek-ai/dsh-computer-use', '@deepseek-ai/dsh-browser-use']) {
  patch = patch.replace(`name: '${pkg}'`, `name: '${import.meta.resolve(pkg)}'`);
}
patch = patch.replace("name: './neo-providers.mjs'", `name: '${new URL('./neo-providers.mjs', import.meta.url).href}'`);
const patchPath = join(state, 'cordis.patch.yml');
await writeFile(patchPath, patch);

const child = spawn(process.execPath, [cli, '--profile', 'sdk', '--patch', patchPath], {
  cwd: root,
  env: { ...process.env, DSH_HOME: join(state, 'home'), DSH_AGENTS_HOME: join(state, 'agents'), DSH_TELEMETRY_DISABLED: '1', TMUX: '', TMUX_PANE: '' },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
let id = 0;
let exited = false;
let exitInfo;
let stderr = '';
const pending = new Map();
const events = [];
const statuses = [];
let exitResolve;
const exitPromise = new Promise(resolve => { exitResolve = resolve; });
child.once('exit', (code, signal) => { exited = true; exitInfo = { code, signal }; exitResolve(exitInfo); for (const [key, p] of pending) p.reject(new Error('process exited: ' + code)); pending.clear(); });
child.stderr.on('data', chunk => { stderr += chunk.toString(); if (stderr.length > 12000) stderr = stderr.slice(-12000); });
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
lines.on('line', line => {
  try {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    } else if (msg.method === 'session.event') events.push(msg.params);
    else if (msg.method === 'session.status') statuses.push(msg.params);
    else if (msg.method) console.log('NOTIFICATION', msg.method);
  } catch (error) { console.log('INVALID_STDOUT', line.slice(0, 200), String(error)); }
});
function rpc(method, params, timeoutMs = 45000) {
  if (exited) return Promise.reject(new Error('process already exited'));
  const seq = ++id;
  let timer;
  const promise = new Promise((resolve, reject) => {
    pending.set(seq, { resolve, reject });
    timer = setTimeout(() => {
      pending.delete(seq);
      reject(new Error(method + ' timeout (' + timeoutMs + 'ms)'));
    }, timeoutMs);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: seq, method, ...(params === undefined ? {} : { params }) }) + '\n');
  });
  return promise.finally(() => clearTimeout(timer));
}
try {
  const init = await rpc('initialize', { cwd, provider: 'neo-scripted', model: 'scripted' });
  console.log('INIT', JSON.stringify(init));
  if (init.serverInfo?.name !== 'deepseek-harness-sdk-runtime') throw new Error('unexpected init response');
  const sessionId = 'neo-sdk-smoke-1';
  const receipt = await rpc('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: 'Say the scripted reply.' }] });
  console.log('PROMPT', JSON.stringify(receipt));
  await rpc('session/wait', { sessionId }, 45000);
  console.log('WAIT', 'settled');
  const summaries = events.map(({ event }) => ({ type: event.type, text: JSON.stringify(event).includes('Neo scripted') ? 'contains scripted reply' : undefined }));
  console.log('EVENTS', JSON.stringify(summaries).slice(0, 2100));
  console.log('STATUS', JSON.stringify(statuses));
  const assistant = events.find(x => x.event?.type === 'assistant/message');
  console.log('ASSISTANT_EVENT', JSON.stringify(assistant?.event).slice(0, 700));
  if (!JSON.stringify(events).includes('Neo scripted DSH SDK reply.')) throw new Error('model reply not present in session events');
  if (!statuses.some(x => x.status === 'idle')) throw new Error('missing idle status');
  console.log('PASS', 'live SDK initialize/prompt/events/wait');
  await rpc('shutdown', undefined, 15000);
  console.log('SHUTDOWN', 'acknowledged');
} catch (error) {
  console.log('FAIL', String(error));
  process.exitCode = 1;
} finally {
  child.stdin.end();
  if (!exited) {
    const result = await Promise.race([exitPromise, new Promise(r => setTimeout(() => r(null), 3000))]);
    if (!result) { child.kill(); await Promise.race([exitPromise, new Promise(r => setTimeout(r, 2000))]); }
  }
  console.log('PROCESS', JSON.stringify(exitInfo ?? { status: 'pending' }));
  if (exitInfo?.code !== 0) process.exitCode = 1;
  if (!stderr.includes('NEO_REGISTRY computer=neo-computer-stub browser=neo-browser-stub')) {
    console.log('FAIL', 'both provider registrations not confirmed');
    process.exitCode = 1;
  }
  console.log('STDERR_TAIL', stderr.slice(-2400).replaceAll(state, '<temp>'));
  await rm(state, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
}
