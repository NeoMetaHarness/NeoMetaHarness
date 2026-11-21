import assert from 'node:assert/strict';
import { ComputerRegistry } from '@neometaharness/computers';
import { DshAgentRuntime } from '../src/runtime.js';

const computers = new ComputerRegistry(() => 'http://127.0.0.1/unused', () => {});
const unregister = computers.registerProvider('dsh-assignment-test', {
  capabilities: { screen: true, input: true, browserCdp: false, shell: false, files: false, snapshot: false },
  provision: () => ({ screen: () => ({ protocol: 'png' }), lease: () => {}, input: () => {},
    capture: () => ({ png: 'fake', width: 1, height: 1 }) }),
  attach: () => ({ screen: () => ({ protocol: 'png' }), lease: () => {}, input: () => {},
    capture: () => ({ png: 'fake', width: 1, height: 1 }) }),
  release: () => {},
});

try {
  const alpha = await computers.provision('dsh-assignment-test', {}, { workspaceId: 'alpha' });
  const bravo = await computers.provision('dsh-assignment-test', {}, { workspaceId: 'bravo' });
  const runtime = new DshAgentRuntime({} as any, '', computers);
  const seed = (sessionId: string, workspaceId: string) => {
    (runtime as any).sessions.set(sessionId, { stop: async () => {} });
    (runtime as any).sessionWorkspaces.set(sessionId, workspaceId);
  };

  seed('cancelled', 'alpha');
  seed('other', 'bravo');
  computers.assign('dsh', 'cancelled', alpha.id, 'alpha');
  computers.assign('dsh', 'other', bravo.id, 'bravo');
  assert.deepEqual(await runtime.cancel({ sessionId: 'cancelled' }), { cancelled: true });
  assert.equal(computers.binding('dsh', 'cancelled', 'alpha'), undefined);
  assert.ok(computers.binding('dsh', 'other', 'bravo'), 'other workspace is unaffected');

  seed('shutdown', 'alpha');
  computers.assign('dsh', 'shutdown', alpha.id, 'alpha');
  assert.deepEqual(await runtime.shutdown({ sessionId: 'shutdown' }), { stopped: true });
  assert.equal(computers.binding('dsh', 'shutdown', 'alpha'), undefined);

  await runtime.stop();
  assert.equal(computers.binding('dsh', 'other', 'bravo'), undefined);
  console.log('DSH ASSIGNMENTS PASS cancel/shutdown/runtime-stop release workspace-scoped bindings');
} finally {
  await unregister();
}
