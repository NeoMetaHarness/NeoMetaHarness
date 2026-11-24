import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { T3Event } from '@neometaharness/contracts';
import type { NeoExtension } from '@neometaharness/kernel';

const survey = [
  'Before the form.',
  '```a2ui',
  JSON.stringify([{ version: '1.0', createSurface: {
    surfaceId: 'testSurvey', catalogId: 'neometaharness:chat:v1', dataModel: { name: '', approved: false },
    components: [
      { id: 'root', component: 'Column', children: ['title', 'note', 'name', 'approved', 'submit'] },
      { id: 'title', component: 'Heading', text: 'Scripted survey' },
      { id: 'note', component: 'Text', text: '**Bold note** [sample](https://example.invalid) ![pixel](https://example.invalid/pixel) <img src=x onerror=alert(1)>' },
      { id: 'name', component: 'TextField', label: 'Your name', value: { '@path': '/name' } },
      { id: 'approved', component: 'CheckBox', label: 'Approved', value: { '@path': '/approved' } },
      { id: 'submit', component: 'Button', child: 'buttonLabel', action: { event: {
        name: 'submit', context: { name: { '@path': '/name' }, approved: { '@path': '/approved' } },
      } } },
      { id: 'buttonLabel', component: 'Text', text: 'Send survey' },
    ],
  } }]),
  '```',
  'After the form.',
].join('\n');

type HermesCall = { profile: string; input: string; instructions?: string; sessionId?: string };
export const hermesCalls: HermesCall[] = [];
const runs = new Map<string, { text: string; session: string }>();
export const hermes: NeoExtension = {
  activate(ctx) {
    ctx.route('profiles/list', () => ({ profiles: [{ name: 'default', path: 'fixture' }] }));
    ctx.route('runs/start', ({ body }) => {
      const request = body as HermesCall;
      hermesCalls.push(request);
      const id = randomUUID();
      runs.set(id, { text: request.input.startsWith('{') ? 'Hermes received your survey.' :
        request.input.includes('ordinary') ? 'Hermes plain text continues.' : survey,
        session: request.sessionId ?? 'hermes-' + id });
      return { run_id: id };
    });
    ctx.route('runs/status', ({ body }) => ({
      status: 'completed', session_id: runs.get((body as { runId: string }).runId)?.session,
    }));
    ctx.route('runs/events', async function* ({ body }) {
      const { runId } = body as { runId: string };
      const text = runs.get(runId)!.text;
      yield { kind: 'text.delta', messageId: runId, textDelta: text.slice(0, 19) };
      yield { kind: 'text.delta', messageId: runId, textDelta: text.slice(19) };
      yield { kind: 'event', type: 'run.completed' };
    });
  },
};

type T3Call = { threadId: string; text: string; messageId: string };
type Run = { id: string; userMessageId: string; status: string };
type Message = { id: string; role: string; runId: string; text: string };
const threads = new Map<string, {
  title: string; queue: T3Event[]; changes: EventEmitter; runs: Run[]; messages: Message[];
}>();
const projectId = 'fixture-project';
export const t3Calls: T3Call[] = [];
export const t3: NeoExtension = {
  activate(ctx) {
    ctx.route('providers/list', () => ({ providers: [{
      id: 'neo-coding', name: 'neo-coding', status: 'ready', models: [{ id: 'fixture', name: 'Fixture', isDefault: true }],
    }] }));
    ctx.route('threads/list', () => ({
      projects: [{ id: projectId, title: 'Fixture project', workspaceRoot: 'fixture' }],
      threads: [...threads].map(([id, thread]) => ({
        id, projectId, title: thread.title, status: 'ready', activeRunId: null, itemCount: thread.messages.length,
        pendingRuntimeRequest: null,
      })),
    }));
    ctx.route('create', ({ body }) => {
      const { threadId, title } = body as { threadId: string; title: string };
      threads.set(threadId, { title, queue: [], changes: new EventEmitter(), runs: [], messages: [] });
      return { sequence: 0 };
    });
    ctx.route('send', ({ body }) => {
      const request = body as T3Call;
      t3Calls.push(request);
      const thread = threads.get(request.threadId)!;
      const run = { id: randomUUID(), userMessageId: request.messageId, status: 'completed' };
      const text = request.text.startsWith('{') ? 'T3 received your survey.' : survey;
      const message = { id: randomUUID(), role: 'assistant', runId: run.id, text };
      const delta = (textDelta: string): T3Event => ({
        kind: 'text.delta', fullText: true, messageId: message.id, textDelta, payload: message,
      });
      thread.runs.push(run);
      thread.messages.push({ id: request.messageId, role: 'user', text: request.text, runId: run.id }, message);
      thread.queue.push(delta('A T3 revision that is replaced.'), delta(text),
        { kind: 'event', type: 'run.updated', payload: run });
      thread.changes.emit('events');
      return { sequence: thread.queue.length };
    });
    ctx.route('events', async function* ({ body }) {
      const { threadId, signal } = body as { threadId: string; signal: AbortSignal };
      const thread = threads.get(threadId)!;
      let position = thread.queue.length;
      yield { kind: 'snapshot', payload: { projection: {
        messages: thread.messages, runs: thread.runs,
        turnItems: thread.messages.map((message) => ({ item: {
          type: message.role + '_message', messageId: message.id, text: message.text,
        } })),
      } } };
      while (!signal.aborted) {
        if (position < thread.queue.length) yield thread.queue[position++];
        else await once(thread.changes, 'events', { signal }).catch(() => {});
      }
    });
  },
};
