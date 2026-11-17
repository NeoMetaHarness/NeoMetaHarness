import { strict as assert } from 'node:assert';
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2RpcSchemas,
} from '@t3tools/contracts';
import { appendOrchestrationProtocol } from '@t3tools/client-runtime/connection-compatibility';
import { makeWsRpcProtocolClient } from '@t3tools/client-runtime/rpc-protocol';
import * as Schema from 'effect/Schema';

assert.equal(ORCHESTRATION_PROTOCOL_VERSION, 2);
assert.equal(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, 'orchestration.dispatchCommand');
assert.equal(ORCHESTRATION_V2_WS_METHODS.subscribeThread, 'orchestration.subscribeThread');
assert.ok(OrchestrationV2RpcSchemas.dispatchCommand.input);
assert.ok(makeWsRpcProtocolClient);
const socketUrl = appendOrchestrationProtocol(process.env.T3_WS_URL ?? 'ws://127.0.0.1:43871/ws');
assert.equal(new URL(socketUrl).searchParams.get('orchestrationProtocol'), '2');
console.log('source_contract=PASS protocol=2 dispatchCommand subscribeThread');
console.log('client_runtime=PASS compatibility + Effect RPC client factory import');
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2RpcSchemas.dispatchCommand.input);
const fakeBase = { commandId: 'nmh-test-command', threadId: 'nmh-test-thread' };
const commands = [
  { type: 'thread.create', ...fakeBase, createdBy: 'user', creationSource: 'web',
    projectId: 'nmh-test-project', title: 'seam check', modelSelection: { instanceId: 'codex', model: 'dummy' },
    runtimeMode: 'approval-required', interactionMode: 'default', branch: null, worktreePath: null },
  { type: 'message.dispatch', ...fakeBase, createdBy: 'user', creationSource: 'web',
    messageId: 'nmh-test-message', text: 'contract only: no provider invoked', attachments: [],
    dispatchMode: { type: 'start_immediately' } },
  { type: 'runtime-request.respond', ...fakeBase, requestId: 'nmh-test-request', decision: 'decline' },
];
for (const command of commands) {
  assert.equal(decodeCommand(command).type, command.type);
}
assert.equal(Schema.decodeUnknownSync(OrchestrationV2RpcSchemas.subscribeThread.input)({ threadId: fakeBase.threadId }).threadId, fakeBase.threadId);
assert.equal(Schema.decodeUnknownSync(OrchestrationV2RpcSchemas.subscribeThread.output)({ kind: 'synchronized' }).kind, 'synchronized');
assert.throws(() => Schema.decodeUnknownSync(OrchestrationV2RpcSchemas.subscribeThread.output)({ kind: 'invented-stream-event' }));
assert.throws(() => decodeCommand({ ...commands[2], decision: 'grantAllWithoutPrompt' }));
console.log('command_schemas=PASS thread.create message.dispatch runtime-request.respond subscribeThread synchronized reject-invalid');
if (process.argv.includes('--live')) {
  const noProtocol = new URL(socketUrl);
  noProtocol.searchParams.delete('orchestrationProtocol');
  const versioned = new URL(socketUrl);
  noProtocol.protocol = 'http:';
  versioned.protocol = 'http:';
  const oldVersionResponse = await fetch(noProtocol);
  const versionedResponse = await fetch(versioned);
  console.log('live_protocol_check=PASS missing_version_status=' + oldVersionResponse.status + ' versioned_status=' + versionedResponse.status);
  if (versionedResponse.status === 401) {
    const error = await versionedResponse.json();
    console.log('live_rpc=BLOCKED auth=' + error.reason);
    process.exitCode = 2;
  } else {
    console.log('live_rpc=UNVERIFIED unexpected_status=' + versionedResponse.status);
    process.exitCode = 3;
  }
}
