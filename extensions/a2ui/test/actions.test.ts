import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ActionStore, type ActionTarget } from '../src/actions.js';

test('actions bind the caller, surface, component and fields and dispatch once', async () => {
  const store = new ActionStore();
  let sends = 0;
  const target: ActionTarget = {
    actor: { userId: 'user', workspaceId: 'a' }, conversationId: 'thread', revision: 'message:1',
    async send(text) {
      sends++;
      const message = JSON.parse(text);
      assert.equal(message.version, '1.0');
      assert.deepEqual({ ...message.action, timestamp: undefined }, {
        surfaceId: 'form', sourceComponentId: 'submit', name: 'send', context: { name: 'Ada' }, timestamp: undefined,
      });
      return { engine: 't3', sequence: 12 };
    },
  };
  const action = { componentId: 'submit', name: 'send', fields: { name: { path: '/name', type: 'string' as const } } };
  const handle = store.issue(target, 'form', action)!;
  assert.equal(store.issue(target, 'form', action), handle);
  const input = { handle, idempotencyKey: randomUUID(), fields: { name: 'Ada' } };
  assert.throws(() => store.dispatch({ ...target.actor, workspaceId: 'b' }, input), { code: 'NOT_FOUND' });
  assert.throws(() => store.dispatch({ ...target.actor, userId: 'another' }, input), { code: 'NOT_FOUND' });
  assert.throws(() => store.dispatch(target.actor, { ...input, fields: { private: true } }), { code: 'BAD_REQUEST' });
  const pending = store.dispatch(target.actor, input);
  assert.equal(store.dispatch(target.actor, input), pending);
  assert.deepEqual(await pending, { engine: 't3', sequence: 12 });
  assert.equal(sends, 1);
  assert.throws(() => store.dispatch(target.actor, { ...input, idempotencyKey: randomUUID() }), { code: 'CONFLICT' });
  store.close();
  assert.throws(() => store.dispatch(target.actor, input), { code: 'NOT_FOUND' });
});
