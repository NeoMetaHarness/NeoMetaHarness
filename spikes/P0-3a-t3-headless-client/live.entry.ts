import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Effect from 'effect/Effect';
import * as Deferred from 'effect/Deferred';
import * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';
import { Socket } from 'effect/socket';
import { RpcClient, RpcSerialization } from 'effect/rpc';
import { ORCHESTRATION_PROTOCOL_VERSION, WS_METHODS } from '@t3tools/contracts';
import { makeWsRpcProtocolClient } from '@t3tools/client-runtime/rpc-protocol';

// The caller supplies a scoped session in process memory. This code never issues or logs a token.
const scopedSession = process.env.NMH_T3_SCOPED_SESSION;
if (!scopedSession) {
  console.error('live_e2e=NOT_RUN missing NMH_T3_SCOPED_SESSION (requires scoped local T3 bearer session)');
  process.exit(2);
}
const origin = 'http://127.0.0.1:43871';
const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${scopedSession}` },
});
if (!ticketResponse.ok) throw new Error(`ticket_failed status=${ticketResponse.status}`);
const { ticket } = await ticketResponse.json();
assert.equal(typeof ticket, 'string');
const socketUrl = `ws://127.0.0.1:43871/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket)}`;
const layerSocket = Socket.layerWebSocket(socketUrl).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
const layerProtocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(layerSocket), Layer.provide(RpcSerialization.layerJson),
);
const fakeAgentPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fake-acp.mjs');
const providerId = 'nmhFakeAcp';
const threadId = randomUUID();
const command = (type, other) => ({ type, commandId: randomUUID(), threadId, ...other });
const recorded = { sequences: [], streamedText: [], pending: false, declined: false, settled: false, resolved: false, runStatus: null };

const program = Effect.gen(function* () {
  const client = yield* makeWsRpcProtocolClient;
  yield* client[WS_METHODS.serverUpdateSettings]({
    patch: {},
    providerInstanceMutation: {
      operation: 'upsert', instanceId: providerId,
      instance: { driver: 'acpRegistry', displayName: 'NMH isolated fake ACP', enabled: true,
        config: { source: 'local', commandPath: process.execPath, commandArgs: [fakeAgentPath] } },
    },
  });
  console.log('provider=local_fake_acp registered');
  const projectId = randomUUID();
  yield* client[WS_METHODS.projectsMutate]({
    type: 'project.create', commandId: randomUUID(), projectId,
    title: 'NMH fake T3 E2E project',
    workspaceRoot: path.resolve(path.dirname(fakeAgentPath), '.cache', 'live-project-' + threadId),
    createWorkspaceRootIfMissing: true,
  });
  console.log('project.create=ACK isolated_workspace=true');
  const created = yield* client['orchestration.dispatchCommand'](command('thread.create', {
    createdBy: 'user', creationSource: 'web', projectId, title: 'NMH isolated T3 fake ACP live test',
    modelSelection: { instanceId: providerId, model: 'default' },
    runtimeMode: 'approval-required', interactionMode: 'default', branch: null, worktreePath: null,
  }));
  console.log(`thread.create=ACK sequence=${created.sequence}`);
  const synced = yield* Deferred.make();
  const runDone = yield* Deferred.make();
  const requestResolved = yield* Deferred.make();
  const settled = yield* Deferred.make();
  yield* client['orchestration.subscribeThread']({ threadId }).pipe(
    Stream.runForEach(Effect.fn(function* (item) {
      if (item.kind === 'snapshot' || item.kind === 'synchronized') {
        console.log(`subscribeThread=${item.kind}`);
        yield* Deferred.succeed(synced, true);
        return;
      }
      if (item.kind !== 'event') return;
      const previous = recorded.sequences.at(-1);
      if (previous !== undefined) assert.ok(item.sequence > previous, 'stream events must have increasing sequence');
      recorded.sequences.push(item.sequence);
      if (item.event.type === 'run.updated') {
        const status = item.event.payload.status;
        if (status !== recorded.runStatus) console.log(`run.updated sequence=${item.sequence} status=${status}`);
        recorded.runStatus = status;
        if (['completed', 'failed', 'cancelled', 'rolled_back'].includes(status)) yield* Deferred.succeed(runDone, status);
      }
      if (item.event.type === 'message.updated' && item.event.payload.role === 'assistant') {
        const text = item.event.payload.text;
        recorded.streamedText.push(text);
        console.log(`message.updated sequence=${item.sequence} text_chars=${text.length}`);
      }
      if (item.event.type === 'runtime-request.updated') {
        const request = item.event.payload;
        if (request.status === 'pending' && !recorded.pending) {
          recorded.pending = true;
          console.log(`runtime-request.updated sequence=${item.sequence} status=pending`);
          const ack = yield* client['orchestration.dispatchCommand'](command('runtime-request.respond', {
            requestId: request.id, decision: 'decline',
          }));
          recorded.declined = true;
          console.log(`runtime-request.respond=ACK sequence=${ack.sequence} decision=decline`);
        }
        if (request.status !== 'pending') console.log(`runtime-request.updated sequence=${item.sequence} status=${request.status}`);
        if (request.status === 'resolved') {
          recorded.resolved = true;
          yield* Deferred.succeed(requestResolved, true);
        }
      }
      if (item.event.type === 'thread.settled') {
        recorded.settled = true;
        console.log(`thread.settled sequence=${item.sequence}`);
        yield* Deferred.succeed(settled, true);
      }
    })),
    Effect.forkScoped,
  );
  yield* Deferred.await(synced).pipe(Effect.timeout('20 seconds'));
  const dispatched = yield* client['orchestration.dispatchCommand'](command('message.dispatch', {
    createdBy: 'user', creationSource: 'web', messageId: randomUUID(),
    text: 'Return fake streamed text and ask one permission.', attachments: [],
    dispatchMode: { type: 'start_immediately' },
  }));
  console.log(`message.dispatch=ACK sequence=${dispatched.sequence}`);
  const terminalStatus = yield* Deferred.await(runDone).pipe(Effect.timeout('40 seconds'));
  assert.equal(terminalStatus, 'completed', `fake provider run should complete, got ${terminalStatus}`);
  yield* Deferred.await(requestResolved).pipe(Effect.timeout('10 seconds'));
  const settleAck = yield* client['orchestration.dispatchCommand'](command('thread.settle', {}));
  console.log(`thread.settle=ACK sequence=${settleAck.sequence}`);
  yield* Deferred.await(settled).pipe(Effect.timeout('10 seconds'));
  assert.ok(recorded.sequences.length > 0, 'no sequenced stream events');
  assert.ok(recorded.pending, 'no pending approval seen');
  assert.ok(recorded.declined, 'decline was not acknowledged');
  assert.ok(recorded.resolved, 'resolved approval was not streamed');
  assert.equal(recorded.streamedText.join(''), 'neo fake streamed text, part two. Approval declined.', 'expected ordered streamed fake model text');
  assert.ok(recorded.settled, 'thread did not settle');
  console.log(`stream_text=${JSON.stringify(recorded.streamedText.join(''))} ordered_sequences=true`);
  console.log(`live_e2e=PASS events=${recorded.sequences.length} streamed_messages=${recorded.streamedText.length} run=completed pending=true declined=true resolved=true settled=true`);
});
await Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(layerProtocol)));
