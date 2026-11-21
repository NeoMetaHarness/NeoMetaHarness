import assert from 'node:assert/strict';
import { BoatComputerProvider } from '../src/provider.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCj8AAAAASUVORK5CYII=', 'base64');
let failure: 'exit' | 'xdotool' | 'abort' | undefined;
let signalCommandStarted: (() => void) | undefined;
const calls: { path: string; body: Record<string, unknown> }[] = [];

const fakeHttp: typeof fetch = async (url, init) => {
  assert.equal(init?.redirect, 'error');
  const path = new URL(String(url)).pathname;
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
  calls.push({ path, body });
  let response: unknown;
  if (path === '/api/v1/sandboxes') {
    response = { sandbox: { id: 'bx_23456789' } };
  } else if (path.endsWith('/commands')) {
    if (failure === 'abort') {
      failure = undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        signalCommandStarted?.();
      });
    }
    if (failure) {
      response = failure === 'exit'
        ? { success: true, exitCode: 9, stdout: '', stderr: 'command failed' }
        : { success: false, exitCode: 127, stdout: '', stderr: 'xdotool: missing' };
      failure = undefined;
    } else {
      const code = Buffer.from(/b64decode\('([^']+)'\)/.exec(String(body.command))![1], 'base64').toString();
      response = { success: true, exitCode: 0, stdout: code.includes("'import','-window'") ? png.toString('base64') : '' };
    }
  } else if (path.endsWith('/desktop')) {
    response = { desktopUrl: 'https://example.test/view?capability=private' };
  } else if (path.endsWith('/snapshots/latest')) {
    response = { id: 'snap-1' };
  } else if (path.endsWith('/stop')) {
    response = { success: true };
  } else {
    throw new Error(`Unexpected fake Boat request: ${path}`);
  }
  return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
};

const provider = new BoatComputerProvider(() => ({
  apiKey: 'fake-only', baseUrl: 'https://boat.example/api/v1',
}), fakeHttp);

try {
  const id = 'neo-111111111111111111111111';
  const computer = await provider.provision({ id }, { workspaceId: 'workspace-A' });
  assert.equal((calls[0].body.labels as Record<string, string>)['neo-workspace'], 'workspace-A');
  const screen = computer.screen as (access?: { workspaceId: string; holder: 'agent' | 'human'; principalId: string }) => Promise<{ protocol: string; url?: string }>;
  const lease = computer.lease as (holder: 'agent' | 'human', principalId?: string) => Promise<void> | void;
  const snapshot = computer.snapshot as (access?: { workspaceId: string }) => Promise<unknown>;
  await assert.rejects(screen(), /lease holder/);
  await assert.rejects(screen({ workspaceId: 'workspace-B', holder: 'agent', principalId: 'agent-one' }), /lease holder/);
  await assert.rejects(screen({ workspaceId: 'workspace-A', holder: 'agent', principalId: 'agent-one' }), /lease holder/,
    'an unbound agent lease cannot disclose the stream');
  await lease('agent', 'agent-one');
  await assert.rejects(screen({ workspaceId: 'workspace-A', holder: 'agent', principalId: 'agent-two' }), /lease holder/);
  assert.equal((await screen({ workspaceId: 'workspace-A', holder: 'agent', principalId: 'agent-one' })).protocol, 'webrtc');
  await lease('human', 'user-one');
  await assert.rejects(screen({ workspaceId: 'workspace-A', holder: 'agent', principalId: 'agent-one' }), /lease holder/);
  await assert.rejects(screen({ workspaceId: 'workspace-A', holder: 'human', principalId: 'user-two' }), /lease holder/);
  assert.equal((await screen({ workspaceId: 'workspace-A', holder: 'human', principalId: 'user-one' })).protocol, 'webrtc');
  await lease('human', 'user-two');
  await assert.rejects(screen({ workspaceId: 'workspace-A', holder: 'human', principalId: 'user-one' }), /lease holder/,
    'a superseded user lease cannot disclose the stream');
  await lease('agent', 'agent-one');
  assert.throws(() => snapshot(), /workspace/);
  assert.throws(() => snapshot({ workspaceId: 'workspace-B' }), /workspace/);
  assert.deepEqual(await snapshot({ workspaceId: 'workspace-A' }), { id: 'snap-1' });
  await assert.rejects(provider.saveSnapshot(id, 'workspace-B'), /workspace/);
  await assert.rejects(provider.provision({ id: 'neo-222222222222222222222222', forkOf: id }, { workspaceId: 'workspace-B' }), /same workspace/);
  const otherComputer = await provider.provision({ id: 'neo-333333333333333333333333' }, { workspaceId: 'workspace-B' });
  const otherProvision = calls.filter(call => call.path === '/api/v1/sandboxes').at(-1)!;
  assert.equal((otherProvision.body.labels as Record<string, string>)['neo-workspace'], 'workspace-B');
  const otherScreen = otherComputer.screen as (access?: { workspaceId: string; holder: 'agent' | 'human'; principalId: string }) => Promise<{ protocol: string }>;
  await assert.rejects(otherScreen({ workspaceId: 'workspace-A', holder: 'agent', principalId: 'agent-one' }), /lease holder/);
  await assert.rejects(otherScreen({ workspaceId: 'workspace-B', holder: 'agent', principalId: 'agent-one' }), /lease holder/);
  failure = 'exit';
  await assert.rejects(Promise.resolve(computer.input({ action: 'key', keys: 'Enter' })), /command failed/);
  failure = 'xdotool';
  await assert.rejects(Promise.resolve(computer.input({ action: 'click', x: 2, y: 3 })), /command failed/);
  const started = new Promise<void>(resolve => { signalCommandStarted = resolve; });
  failure = 'abort';
  const pending = Promise.resolve(computer.input({ action: 'click', x: 4, y: 5 }));
  await started;
  computer.interrupt?.();
  await assert.rejects(pending, /abort/i);
  computer.resumeInput?.();
  assert.equal((await computer.capture()).width, 1);
  console.log('Boat provider PASS workspace+snapshot=true lease+screen=true failed-command+xdotool+abort=true');
} finally {
  await provider.close();
}
