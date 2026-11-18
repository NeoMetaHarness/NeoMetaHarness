import '../../engine-t3/test/wire.entry.ts';
import assert from 'node:assert/strict';
import * as Schema from 'effect/Schema';
import { OrchestrationV2RpcSchemas, ProviderInstanceMutation, WsRpcGroup, WS_METHODS } from '@t3tools/contracts';

const decode = Schema.decodeUnknownSync(OrchestrationV2RpcSchemas.dispatchCommand.input);
const base = { commandId: 'workflow-wire', threadId: 'thread-wire' };
decode({ ...base, type: 'thread.model-selection.set', modelSelection: { instanceId: 'neo-coding', model: 'default' } });
decode({ ...base, type: 'thread.metadata.update', branch: 'neo/feature', worktreePath: '/tmp/thread', expectedEmpty: true });
Schema.decodeUnknownSync(ProviderInstanceMutation)({ operation: 'upsert', instanceId: 'neo-coding', instance: {
  driver: 'acpRegistry', displayName: 'Neo coding (DSH)', enabled: true,
  config: { source: 'local', commandPath: 'node', commandArgs: ['acp.mjs', 'pipe', 'token-file'] },
} });
for (const [method, input] of [
  [WS_METHODS.vcsCreateWorktree, { cwd: '/tmp/project', refName: 'HEAD', newRefName: 'neo/feature', path: null }],
  [WS_METHODS.terminalOpen, { threadId: base.threadId, terminalId: 'terminal', cwd: '/tmp/thread' }],
  [WS_METHODS.terminalObserve, { threadId: base.threadId, terminalId: 'terminal' }],
  [WS_METHODS.terminalWrite, { threadId: base.threadId, terminalId: 'terminal', data: 'node feature.mjs\r' }],
] as const) {
  const request = WsRpcGroup.requests.get(method);
  assert.ok(request, method);
  Schema.decodeUnknownSync(request.payloadSchema)(input);
}
assert.throws(() => decode({ ...base, type: 'thread.model-selection.set', modelSelection: { model: 'default' } }));
console.log('P5-5_WIRE PASS pinned=true provider_config=true provider_switch=true worktree=true terminal=true');
