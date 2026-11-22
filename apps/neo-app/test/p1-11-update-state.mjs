// P1-11: the frontend renders only the shell's update state (update_state), never a reply or payload,
// and drops out-of-order update_state replies by revision.
// Run: node --experimental-strip-types test/p1-11-update-state.mjs
import assert from 'node:assert/strict';
import { createUpdateStore, toUpdateInfo } from '../src/updater.ts';

const snap = (revision, fields = {}) => ({
  generation: 1, revision, available: false, version: null, checking: false, installing: false, error: null, ...fields,
});

/** A fake shell: each update_state call returns a deferred the test resolves in any order. */
function fakeShell() {
  const pending = [];
  const commands = [];
  const args = [];
  const invoke = (name, payload) => {
    if (name !== 'update_state') {
      commands.push(name);
      args.push(payload);
      // A command reply that would be wrong to render: an old "Install" version.
      return Promise.resolve('9.9.9');
    }
    return new Promise((resolve) => pending.push(resolve));
  };
  return { invoke, pending, commands, args };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

// 1. Out-of-order update_state replies: the older (revision 2, Install available) lands after the newer
//    (revision 5, nothing to install). The older must not restore Install.
{
  const shell = fakeShell();
  const store = createUpdateStore(shell.invoke);
  const first = store.refresh();
  const second = store.refresh();
  shell.pending[1](snap(5, { generation: 3 }));
  await second;
  shell.pending[0](snap(2, { available: true, version: '1.2.5' }));
  await first;
  assert.equal(store.get().available, false, 'older reply cannot restore Install');
  assert.equal(store.get().status, 'No newer version found');
}

// 2. A command reply is never rendered: only the update_state that follows it.
{
  const shell = fakeShell();
  const store = createUpdateStore(shell.invoke);
  const seen = [];
  store.subscribe((state) => seen.push(state.version));
  const check = store.check();
  await tick();
  shell.pending[0](snap(3, { checking: true }));
  await tick();
  assert.equal(store.get().status, 'Checking for updates…');
  await tick();
  shell.pending[1](snap(4, { available: true, version: '1.2.6' }));
  await check;
  assert.deepEqual(shell.commands, ['check_for_updates']);
  assert.equal(store.get().version, '1.2.6', 'the version comes from update_state');
  assert.ok(!seen.includes('9.9.9'), 'the command reply is never applied');
}

// 3. A webview reload starts empty and renders the shell's current state, not a cached startup payload.
{
  const shell = fakeShell();
  const store = createUpdateStore(shell.invoke);
  assert.equal(store.get().status, '');
  const load = store.refresh();
  shell.pending[0](snap(7, { generation: 2, available: false }));
  await load;
  assert.equal(store.get().available, false);
}

// 4. Rendering is a pure function of the snapshot.
assert.deepEqual(toUpdateInfo(snap(1, { generation: 0 })), { generation: 0, available: false, version: null, status: '', checking: false, error: null });
assert.equal(toUpdateInfo(snap(1, { generation: 4, available: true, version: '1.2.4' })).generation, 4, 'rendered with its generation');

// Settings captures the pair at render and passes it to installUpdate.
{
  const { readFileSync } = await import('node:fs');
  const settings = readFileSync(new URL('../src/pages/Settings.tsx', import.meta.url), 'utf8');
  assert.match(settings, /const shownCandidate =\s+updateInfo\.available && updateInfo\.version \? \{ generation: updateInfo\.generation, version: updateInfo\.version \}/);
  assert.match(settings, /onClick=\{\(\) => void installUpdate\(shownCandidate\)\}/);
  assert.ok(!/installUpdate\(\)/.test(settings), 'no install without the rendered pair');
}
assert.equal(toUpdateInfo(snap(1, { error: 'offline' })).status, 'offline');
assert.equal(toUpdateInfo(snap(1, { available: true, version: '1.2.4', installing: true })).available, false, 'no second Install while installing');
assert.equal(toUpdateInfo(snap(1, { available: true, version: '1.2.4', installing: true })).status, 'Installing update and restarting…');

// 5. Install sends exactly the {generation, version} captured when the button rendered, even if the store
//    has since moved on to a newer snapshot (the shell then refuses the stale pair).
{
  const shell = fakeShell();
  const store = createUpdateStore(shell.invoke);
  const load = store.refresh();
  shell.pending[0](snap(4, { generation: 6, available: true, version: '1.2.5' }));
  await load;
  const shown = { generation: store.get().generation, version: store.get().version };
  const later = store.refresh();
  shell.pending[1](snap(5, { generation: 7, available: true, version: '1.2.6' }));
  await later;
  assert.equal(store.get().generation, 7);
  shell.pending.splice(0, 2);
  const install = store.install(shown);
  await tick();
  shell.pending[0](snap(6, { generation: 7, available: true, version: '1.2.6', error: 'Update state changed, check again' }));
  await tick();
  shell.pending[1](snap(6, { generation: 7, available: true, version: '1.2.6', error: 'Update state changed, check again' }));
  await install;
  assert.deepEqual(shell.commands, ['install_update']);
  assert.deepEqual(shell.args, [{ generation: 6, version: '1.2.5' }], 'the rendered pair, not the latest state');
  assert.equal(store.get().status, 'Update state changed, check again', 'a refusal is shown from update_state');
}

// 6. No shell (web/PWA): nothing to read, nothing rendered.
{
  const store = createUpdateStore(null);
  await store.check();
  assert.equal(store.get().status, '');
}

console.log('P1-11_UPDATE_STATE PASS single source of truth, out-of-order replies dropped by revision, replies never rendered, install sends the rendered generation and version');
