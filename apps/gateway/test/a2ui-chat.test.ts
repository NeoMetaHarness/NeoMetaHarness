import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { T3Event } from '@neometaharness/contracts';
import { SqliteDatabaseProvider } from '@neometaharness/db';
import { ChatUi } from '../src/chat-ui.js';

const actor = { userId: 'alice', workspaceId: 'alpha' };
const other = { userId: 'bob', workspaceId: 'beta' };
const chunks = async function* (...events: T3Event[]) { yield* events; };
const collect = async (stream: AsyncIterable<T3Event>) => {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
};

test('managed Hermes runs resume the resolved session through disable and re-enable', async () => {
  const db = new SqliteDatabaseProvider(':memory:');
  await db.migrate();
  try {
    let enabled = true;
    let counter = 0;
    const sends: unknown[] = [];
    const kernel = {
      hasRoute: () => enabled,
      async invokeRoute(path: string, _method: string, body?: unknown) {
        return path.endsWith('/instructions') ? 'Neo catalog' : body;
      },
    };
    const chat = new ChatUi(db.chat, kernel, async (route, body) => {
      if (route === 'runs/status') return { status: 'completed', session_id: 'resolved-session' };
      sends.push(body);
      return { run_id: 'run-' + ++counter };
    }, async () => {});
    const first = await chat.sendHermes({ profile: 'p', input: 'Show a form', interactive: true }, actor);
    assert.ok(first.conversationId);
    await assert.rejects(chat.requireRun('p', first.run_id, other.workspaceId), { code: 'NOT_FOUND' });
    const binding = await chat.requireRun('p', first.run_id, actor.workspaceId);
    const events = await collect(chat.hermesEvents(chunks(
      { kind: 'text.delta', textDelta: 'a2' }, { kind: 'text.delta', textDelta: 'ui data' },
      { kind: 'event', type: 'run.completed' },
    ), { profile: 'p', runId: first.run_id }, binding, actor));
    assert.equal(events.at(-2)?.type, 'a2ui.message');
    const prepared = events.at(-2)?.payload as { text: string; target: { send(text: string): Promise<unknown> } };
    assert.equal(prepared.text, 'a2ui data');
    await prepared.target.send('submitted');
    enabled = false;
    await chat.sendHermes({ profile: 'p', input: 'ordinary', conversationId: first.conversationId, interactive: true }, actor);
    await assert.rejects(prepared.target.send('repeat'), { code: 'CONFLICT' });
    assert.deepEqual(sends, [
      { profile: 'p', input: 'Show a form', instructions: 'Neo catalog', sessionId: undefined },
      { profile: 'p', input: 'submitted', instructions: 'Neo catalog', sessionId: 'resolved-session' },
      { profile: 'p', input: 'ordinary', instructions: undefined, sessionId: 'resolved-session' },
    ]);
  } finally { await db.close(); }
});

test('T3 complete revisions only derive actions for the matched run and workspace', async () => {
  const db = new SqliteDatabaseProvider(':memory:');
  await db.migrate();
  try {
    const sent: Array<{ threadId: string; text: string; messageId: string }> = [];
    const kernel = { hasRoute: () => true, async invokeRoute(path: string, _method: string, body?: unknown) {
      return path.endsWith('/instructions') ? 'Neo catalog' : body;
    } };
    const chat = new ChatUi(db.chat, kernel, async () => {}, async (route, body) => {
      if (route === 'send') sent.push(body as typeof sent[number]);
      return { sequence: sent.length };
    });
    const { threadId } = await chat.createT3({ threadId: 'untrusted', interactive: true }, actor) as { threadId: string };
    assert.notEqual(threadId, 'untrusted');
    await assert.rejects(chat.requireThread(threadId, other.workspaceId), { code: 'NOT_FOUND' });
    await chat.sendT3({ threadId, text: 'show', interactive: true }, actor);
    const delta = (text: string): T3Event => ({ kind: 'text.delta', messageId: 'a', fullText: true,
      textDelta: text, payload: { runId: 'right' } });
    const completed = (id: string): T3Event => ({ kind: 'event', type: 'run.updated', payload: {
      id, status: 'completed', userMessageId: sent[0].messageId,
    } });
    const events = await collect(chat.t3Events(chunks(delta('a2ui partial'), completed('wrong'),
      delta('a2ui finished'), completed('right')), threadId, actor));
    const decorated = events.filter((event) => event.type === 'a2ui.message');
    assert.equal(decorated.length, 1);
    const prepared = decorated[0].payload as { text: string; target: { send(text: string): Promise<unknown> } };
    assert.equal(prepared.text, 'a2ui finished');
    const replaced = await collect(chat.t3Events(chunks(delta('Plain revised text')), threadId, actor));
    assert.equal(replaced.at(-1)?.type, 'a2ui.message');
    assert.equal(replaced.at(-1)?.payload, undefined);
    await assert.rejects(prepared.target.send('stale after revision'), { code: 'CONFLICT' });
    const updated = await collect(chat.t3Events(chunks(delta('a2ui revised surface')), threadId, actor));
    const latest = updated.at(-1)?.payload as typeof prepared;
    await latest.target.send('action');
    await assert.rejects(prepared.target.send('repeat'), { code: 'CONFLICT' });
    assert.deepEqual(sent.map(({ threadId: id, text }) => [id, text]), [
      [threadId, 'show\n\nNeo catalog'], [threadId, 'action\n\nNeo catalog'],
    ]);
  } finally { await db.close(); }
});
