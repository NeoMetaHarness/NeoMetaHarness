import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { Socket } from 'effect/socket';
import { RpcClient, RpcSerialization } from 'effect/rpc';
import { ORCHESTRATION_PROTOCOL_VERSION, WS_METHODS, OrchestrationV2RpcSchemas } from '@t3tools/contracts';
import { makeWsRpcProtocolClient } from '@t3tools/client-runtime/rpc-protocol';

// This test-only module is bundled against the exact pinned read-only T3 source.
// No private upstream package is loaded by the production extension.
const decode = Schema.decodeUnknownSync(OrchestrationV2RpcSchemas.dispatchCommand.input);
const threadId = randomUUID();
const base = { threadId, commandId: randomUUID() };
const commands = [
  { type: 'thread.create', ...base, projectId: 'project', title: 'test', createdBy: 'user', creationSource: 'web',
    modelSelection: { instanceId: 'nmhFakeAcp', model: 'default' }, runtimeMode: 'approval-required',
    interactionMode: 'default', branch: null, worktreePath: null },
  { type: 'message.dispatch', ...base, messageId: randomUUID(), text: 'test', createdBy: 'user',
    creationSource: 'web', attachments: [], dispatchMode: { type: 'start_immediately' } },
  { type: 'runtime-request.respond', ...base, requestId: 'permission', decision: 'decline' },
  { type: 'thread.settle', ...base },
] as const;
assert.equal(ORCHESTRATION_PROTOCOL_VERSION, 2);
for (const command of commands) assert.equal(decode(command).type, command.type);
Schema.decodeUnknownSync(OrchestrationV2RpcSchemas.subscribeThread.input)({ threadId });
Schema.decodeUnknownSync(OrchestrationV2RpcSchemas.subscribeThread.output)({ kind: 'synchronized' });
assert.throws(() => Schema.decodeUnknownSync(OrchestrationV2RpcSchemas.subscribeThread.output)({ kind: 'invalid' }));
assert.throws(() => decode({ ...commands[2], decision: 'grant_without_asking' }));
console.log('T3_WIRE_SCHEMAS PASS protocol=2 commands=4 stream=valid invalid=rejected');

const origin = process.env.T3_TEST_URL!;
const session = process.env.T3_TEST_SESSION!;
const providerId = process.env.T3_TEST_PROVIDER!;
const projectId = process.env.T3_TEST_PROJECT!;
const workspaceRoot = process.env.T3_TEST_WORKSPACE!;
const fakeAgentPath = process.env.T3_TEST_FAKE_ACP!;
const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
  method: 'POST', headers: { Authorization: `Bearer ${session}` },
});
assert.equal(ticketResponse.status, 200, 'isolated T3 must issue a socket ticket');
const { ticket } = await ticketResponse.json() as { ticket: string };
const url = new URL('/ws', origin);
url.protocol = 'ws:';
url.searchParams.set('orchestrationProtocol', '2');
url.searchParams.set('wsTicket', ticket);
const socket = Socket.layerWebSocket(url.toString()).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
const protocol = RpcClient.layerProtocolSocket().pipe(Layer.provide(socket), Layer.provide(RpcSerialization.layerJson));

await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const client = yield* makeWsRpcProtocolClient;
  yield* client[WS_METHODS.serverUpdateSettings]({
    patch: {}, providerInstanceMutation: {
      operation: 'upsert', instanceId: providerId,
      instance: { driver: 'acpRegistry', displayName: 'NMH isolated fake ACP', enabled: true,
        config: { source: 'local', commandPath: process.execPath, commandArgs: [fakeAgentPath] } },
    },
  });
  yield* client[WS_METHODS.projectsMutate]({
    type: 'project.create', commandId: randomUUID(), projectId,
    title: 'NMH isolated T3 gateway test', workspaceRoot, createWorkspaceRootIfMissing: true,
  });
})).pipe(Effect.provide(protocol)));
console.log('T3_ISOLATED_SETUP PASS fake_provider=true scratch_project=true');
