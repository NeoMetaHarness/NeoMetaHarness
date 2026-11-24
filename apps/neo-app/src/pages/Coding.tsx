import { useEffect, useRef, useState } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type A2uiActionInput, type T3Event } from '@neometaharness/contracts';
import {
  AlertDialog, Badge, Banner, Button, ButtonGroup, Card, CodeBlock, Heading, ChatComposer, ChatLayout, ChatMessage, ChatMessageBubble, ChatMessageList, CheckboxInput,
  StreamView, type StreamViewHandle,
} from '@neometaharness/ui';
import { gatewayUrl, gatewayToken } from '../config';
import { InteractiveReply, replySegments, useInteractiveReplies, type ReplySegment } from '../a2ui';
import './coding.css';
import CodingWorkflow from './CodingWorkflow';

type Client = ContractRouterClient<typeof neoContract>;
type Catalog = Awaited<ReturnType<Client['x']['engine-t3']['threads']['list']>>;
type Providers = Awaited<ReturnType<Client['x']['engine-t3']['providers']['list']>>['providers'];
type Thread = Catalog['threads'][number];
type Message = { id: number; role: 'user' | 'assistant'; text?: string; segments?: ReplySegment[]; generation?: number };
type Approval = { id: string; kind: string; busy: boolean };
type ProjectedItem = { item?: { type?: string; messageId?: string; text?: string } };
type Checkpoint = { id: string; scopeId: string; status: string; ordinalWithinScope: number };

// T3 v0.1.9 orchestration.subscribeThread snapshot carries the thread projection
// (packages/contracts/src/orchestrationV2.ts:3958-3972, :2040-2062).
function historyFromSnapshot(payload: unknown): ProjectedItem[] {
  if (!payload || typeof payload !== 'object') return [];
  const projection = (payload as { projection?: {
    visibleTurnItems?: ProjectedItem[]; turnItems?: ProjectedItem[];
  } }).projection;
  if (!projection) return [];
  const items = projection.visibleTurnItems ?? projection.turnItems ?? [];
  return items.filter((row) => row.item?.type === 'user_message' || row.item?.type === 'assistant_message');
}
const http = createORPCClient<Client>(new HttpLink({
  url: gatewayUrl(),
  headers: () => {
    const token = gatewayToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  },
}));

function isDisabled(error: unknown) {
  const response = error as { code?: string; status?: number } | null;
  return response?.code === 'NOT_FOUND' || response?.status === 404
    || /\b(not[ _-]?found|404|disabled)\b/i.test(String(error));
}

export default function Coding() {
  const [catalog, setCatalog] = useState<Catalog>({ projects: [], threads: [] });
  const [projectId, setProjectId] = useState('');
  const [threadId, setThreadId] = useState('');
  const [title, setTitle] = useState('');
  const [providerId, setProviderId] = useState('');
  const [providers, setProviders] = useState<Providers>([]);
  const [model, setModel] = useState('default');
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [turnCount, setTurnCount] = useState(0);
  const [selectedTurn, setSelectedTurn] = useState(1);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [selectedCheckpoint, setSelectedCheckpoint] = useState('');
  const [restoreRequest, setRestoreRequest] = useState<{ threadId: string; checkpointId: string } | null>(null);
  const [status, setStatus] = useState('Loading');
  const [availability, setAvailability] = useState<'ready' | 'disabled' | 'not_installed' | 'connecting' | 'error'>('connecting');
  const [availabilityReason, setAvailabilityReason] = useState('Connecting to the coding server…');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const a2ui = useInteractiveReplies(http);
  const a2uiGeneration = useRef(a2ui.generation);
  a2uiGeneration.current = a2ui.generation;
  const live = useRef(true);
  const connection = useRef<{ threadId: string; socket: WebSocket } | null>(null);
  const selected = useRef('');
  const views = useRef(new Map<number, StreamViewHandle>());
  const queued = useRef(new Map<number, string>());
  const rendered = useRef(new Map<number, string>());
  const messageIds = useRef(new Map<string, number>());
  const nextId = useRef(0);
  const activeAssistant = useRef<number | null>(null);

  useEffect(() => {
    live.current = true;
    void refresh();
    const interval = window.setInterval(() => { void refresh(true); }, 3000);
    return () => {
      live.current = false;
      clearInterval(interval);
      connection.current?.socket.close();
      connection.current = null;
    };
  }, []);

  useEffect(() => {
    const target = new URLSearchParams(window.location.search).get('openThread');
    if (availability !== 'ready' || !target || selected.current === target || !catalog.threads.some((thread) => thread.id === target)) return;
    openThread(target);
    const url = new URL(window.location.href);
    url.searchParams.delete('openThread');
    window.history.replaceState({}, '', url.pathname + url.search);
  }, [catalog, availability]);

  async function refresh(silent = false) {
    try {
      const extension = (await http.extensions.list()).find((item) => item.id === 'engine-t3');
      if (!live.current) return;
      if (!extension || extension.status === 'disabled') {
        unavailable('disabled', 'disabled');
        return;
      }
      if (!extension.health?.ok) {
        const installation = await http.x['engine-t3'].install.status().catch(() => undefined);
        if (!live.current) return;
        const state = installation?.state === 'not_installed' ? 'not_installed'
          : installation?.state === 'installing' || installation?.phase === 'starting' ? 'connecting' : 'error';
        unavailable(state, state === 'not_installed' ? 'Not installed' : state === 'connecting' ? 'Connecting' : 'Unavailable',
          installation?.error ?? extension.health?.reason ?? installation?.message ?? 'T3 is disconnected.');
        return;
      }
      const [result, providerResult] = await Promise.all([
        http.x['engine-t3'].threads.list(), http.x['engine-t3'].providers.list(),
      ]);
      if (!live.current) return;
      setAvailability('ready');
      setCatalog(result);
      setProviders(providerResult.providers);
      setProjectId((previous) => result.projects.some((project) => project.id === previous)
        ? previous : result.projects[0]?.id ?? '');
      const firstProject = result.projects[0];
      if (firstProject) {
        const preferred = providerResult.providers.find((provider) =>
          provider.id === 'neo-coding' || provider.name === 'neo-coding');
        const projectDefault = providerResult.providers.find((provider) =>
          provider.id === firstProject.defaultModelSelection?.instanceId);
        const chosen = preferred ?? projectDefault ?? providerResult.providers[0];
        setProviderId((previous) => {
          if (previous && providerResult.providers.some((provider) => provider.id === previous)) return previous;
          return chosen?.id ?? '';
        });
        setModel((previous) => previous === 'default'
          ? chosen?.models.find((item) => item.isDefault)?.id
            ?? chosen?.models[0]?.id ?? previous : previous);
      }
      setStatus((previous) => ['disabled', 'Loading', 'Not installed', 'Connecting', 'Unavailable'].includes(previous) ? 'Ready' : previous);
      if (selected.current && !connection.current && result.threads.some((thread) => thread.id === selected.current)) {
        openThread(selected.current);
      } else if (!silent) setError('');
    } catch (reason) {
      if (!live.current || silent) return;
      if (isDisabled(reason)) unavailable('disabled', 'disabled');
      else unavailable('error', 'Unavailable', 'Cannot load coding projects. Check the T3 connection in Extensions.');
    }
  }

  function unavailable(state: 'disabled' | 'not_installed' | 'connecting' | 'error', status: string, reason = '') {
    setAvailability(state);
    setAvailabilityReason(reason);
    setStatus(status);
    setError('');
    setCatalog((current) => current.projects.length || current.threads.length ? { projects: [], threads: [] } : current);
    setProviders((current) => current.length ? [] : current);
    connection.current?.socket.close();
    connection.current = null;
    setRunning(false);
    setSubscribed(false);
  }

  function append(id: number, delta: string) {
    const view = views.current.get(id);
    if (view) view.append(delta);
    else queued.current.set(id, (queued.current.get(id) ?? '') + delta);
  }

  function attach(id: number, view: StreamViewHandle | null) {
    if (!view) {
      views.current.delete(id);
      return;
    }
    views.current.set(id, view);
    const text = queued.current.get(id);
    if (text) {
      view.append(text);
      queued.current.delete(id);
    }
  }

  function receive(id: string, event: T3Event) {
    if (!live.current || selected.current !== id) return;
    if (event.kind === 'snapshot') {
      const history = historyFromSnapshot(event.payload);
      const count = history.filter(({ item }) => item?.type === 'user_message').length;
      setTurnCount(count);
      setSelectedTurn(count || 1);
      const projection = (event.payload as { projection?: {
        checkpoints?: Checkpoint[];
        runs?: Array<{ status: string }>;
        runtimeRequests?: Array<{ id: string; kind: string; status: string }>;
      } })?.projection;
      const activeRun = projection?.runs?.some(({ status }) => ['pending', 'running', 'waiting'].includes(status)) ?? false;
      const pendingApproval = projection?.runtimeRequests?.find(({ status }) => status === 'pending');
      setRunning(activeRun);
      setApproval(pendingApproval ? { id: pendingApproval.id, kind: pendingApproval.kind, busy: false } : null);
      if (pendingApproval || activeRun) setStatus(pendingApproval ? 'Approval required' : 'Running');
      const ready = projection?.checkpoints?.filter((checkpoint) => checkpoint.status === 'ready') ?? [];
      setCheckpoints(ready);
      setSelectedCheckpoint(ready.at(-1)?.id ?? '');
      if (history.length) {
        const restored = history.map(({ item }) => {
          const messageId = ++nextId.current;
          if (item?.messageId) messageIds.current.set(item.messageId, messageId);
          if (item?.type === 'assistant_message') {
            queued.current.set(messageId, item.text ?? '');
            rendered.current.set(messageId, item.text ?? '');
          }
          return { id: messageId, role: item?.type === 'user_message' ? 'user' : 'assistant',
            text: item?.type === 'user_message' ? item.text ?? '' : undefined } satisfies Message;
        });
        setMessages(restored);
      }
    }
    if (event.kind === 'snapshot' || event.kind === 'synchronized') {
      setSubscribed(true);
      setStatus((previous) => previous === 'Connecting' ? 'Ready' : previous);
    }
    if (event.kind === 'text.delta') {
      const key = event.messageId ?? 'assistant';
      let messageId = messageIds.current.get(key);
      if (messageId === undefined) {
        messageId = activeAssistant.current ?? ++nextId.current;
        activeAssistant.current = null;
        messageIds.current.set(key, messageId);
        setMessages((previous) => previous.some((entry) => entry.id === messageId) ? previous
          : [...previous, { id: messageId!, role: 'assistant' }]);
      }
      // T3 message.updated carries the complete revised text (v0.1.9 ws.test.ts:390-437).
      // Reconcile revisions and snapshots without repeating already-rendered text.
      const text = event.textDelta ?? '';
      const previousText = rendered.current.get(messageId) ?? '';
      if (!event.fullText) {
        append(messageId, text);
        rendered.current.set(messageId, previousText + text);
      } else if (text.startsWith(previousText)) append(messageId, text.slice(previousText.length));
      else {
        views.current.get(messageId)?.reset();
        if (views.current.has(messageId)) append(messageId, text);
        else queued.current.set(messageId, text);
      }
      if (event.fullText) rendered.current.set(messageId, text);
      return;
    }
    if (event.kind !== 'event') return;
    const segments = replySegments(event);
    if (event.type === 'a2ui.message' && event.messageId) {
      const messageId = messageIds.current.get(event.messageId);
      if (messageId !== undefined) setMessages((previous) => previous.map((entry) =>
        entry.id === messageId ? { ...entry, segments, generation: a2uiGeneration.current } : entry));
      return;
    }
    const details = event.payload && typeof event.payload === 'object'
      ? event.payload as Record<string, unknown> : {};
    if (event.type === 'runtime-request.updated' && details.status === 'pending' &&
      typeof details.id === 'string') {
      setApproval({ id: details.id, kind: String(details.kind ?? 'Tool action'), busy: false });
      setStatus('Approval required');
    } else if (event.type === 'runtime-request.updated' && details.status === 'resolved') {
      setApproval((previous) => previous?.id === details.id ? null : previous);
      setStatus('Running');
    } else if (event.type === 'run.updated' && ['completed', 'failed', 'cancelled', 'interrupted'].includes(String(details.status))) {
      setStatus(String(details.status));
      setRunning(false);
      for (const view of views.current.values()) view.finish();
    } else if (event.type === 'thread.settled') {
      setStatus('Settled');
      setRunning(false);
    }
  }

  function openThread(id: string) {
    connection.current?.socket.close();
    connection.current = null;
    selected.current = id;
    setThreadId(id);
    setSubscribed(false);
    setMessages([]);
    setApproval(null);
    setDiff(null);
    setTurnCount(0);
    setSelectedTurn(1);
    setCheckpoints([]);
    setSelectedCheckpoint('');
    setRunning(false);
    setError('');
    setStatus('Connecting');
    activeAssistant.current = null;
    messageIds.current.clear();
    queued.current.clear();
    rendered.current.clear();
    views.current.clear();
    const token = gatewayToken();
    const socket = new WebSocket(gatewayUrl().replace(/^http/, 'ws') + '/ws', token ? ['bearer.' + token] : undefined);
    connection.current = { socket, threadId: id };
    const client = createORPCClient<Client>(new WebSocketLink({ websocket: socket }));
    void (async () => {
      try {
        for await (const event of await client.x['engine-t3'].events({ threadId: id })) {
          if (connection.current?.socket !== socket) break;
          receive(id, event);
        }
      } catch (reason) {
        if (live.current && selected.current === id && connection.current?.socket === socket) {
          setStatus(isDisabled(reason) ? 'disabled' : 'Reconnecting');
        }
      } finally {
        socket.close();
        if (connection.current?.socket === socket) {
          connection.current = null;
          setSubscribed(false);
        }
      }
    })();
  }

  async function createThread(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId || !title.trim() || !providerId.trim() || !model.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const id = crypto.randomUUID();
      const created = await http.x['engine-t3'].create({
        threadId: id, projectId, title: title.trim(), providerId: providerId.trim(), model: model.trim(),
        interactive: a2ui.enabled && interactive,
      });
      await refresh();
      openThread(created.threadId ?? id);
      setTitle('');
    } catch (reason) {
      setError(`Could not create thread: ${String(reason)}`);
    } finally {
      setBusy(false);
    }
  }

  async function send(text: string, action?: A2uiActionInput) {
    const input = text.trim();
    if (!threadId || !subscribed || !input || running || busy || status === 'disabled') {
      if (action) throw new Error('The conversation is busy.');
      return;
    }
    setBusy(true);
    setError('');
    setDraft('');
    setStatus('Running');
    setRunning(true);
    setTurnCount((previous) => { setSelectedTurn(previous + 1); return previous + 1; });
    // Some adapters reuse message ids between turns. Bind each turn's ids to its own stream.
    messageIds.current.clear();
    const assistantId = ++nextId.current;
    activeAssistant.current = assistantId;
    setMessages((previous) => [...previous,
      { id: ++nextId.current, role: 'user', text: input },
      { id: assistantId, role: 'assistant' },
    ]);
    try {
      if (action) {
        const result = await http.x.a2ui.action(action);
        if (result.engine !== 't3') throw new Error('Unexpected conversation engine.');
      } else {
        await http.x['engine-t3'].send({ threadId, text: input, interactive: a2ui.enabled && interactive });
      }
    } catch (reason) {
      setRunning(false);
      setStatus(isDisabled(reason) ? 'disabled' : 'Failed');
      setError(`Could not send prompt: ${String(reason)}`);
      if (action) throw reason;
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: 'approve' | 'decline') {
    if (!approval || !threadId || approval.busy) return;
    const request = approval;
    setApproval({ ...request, busy: true });
    try {
      await http.x['engine-t3'].approval({ threadId, requestId: request.id, decision });
      setApproval(null);
      setStatus('Running');
    } catch (reason) {
      setApproval({ ...request, busy: false });
      setError(`Approval failed: ${String(reason)}`);
    }
  }

  async function stop() {
    if (!threadId) return;
    try {
      await http.x['engine-t3'].stop({ threadId });
      setStatus('Stopped');
      setRunning(false);
      setApproval(null);
    } catch (reason) { setError(`Stop failed: ${String(reason)}`); }
  }

  async function settle() {
    if (!threadId) return;
    try {
      await http.x['engine-t3'].settle({ threadId });
      setStatus('Settling');
      await refresh(true);
    } catch (reason) { setError(`Settle failed: ${String(reason)}`); }
  }

  async function showDiff() {
    if (!threadId) return;
    try {
      const result = await http.x['engine-t3'].diff({
        threadId, fromTurnCount: selectedTurn - 1, toTurnCount: selectedTurn,
      });
      setDiff(result.diff || 'No changes');
    } catch {
      setDiff('Diff not available');
    }
  }

  async function restoreCheckpoint(request: { threadId: string; checkpointId: string }) {
    setRestoreRequest(null);
    const checkpoint = checkpoints.find((entry) => entry.id === request.checkpointId);
    if (threadId !== request.threadId || !checkpoint || busy || running) return;
    setBusy(true);
    setError('');
    try {
      await http.x['engine-t3'].rollback({
        threadId, scopeId: checkpoint.scopeId, checkpointId: checkpoint.id,
      });
      openThread(threadId);
    } catch (reason) {
      setError(`Could not restore checkpoint: ${String(reason)}`);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { setRestoreRequest(null); }, [threadId]);

  const project = catalog.projects.find((entry) => entry.id === projectId);
  const threads = catalog.threads.filter((thread) => thread.projectId === projectId);
  const current = catalog.threads.find((thread) => thread.id === threadId);
  return <section className="coding-page" data-testid="coding-page">
    <header className="page-header">
      <div><h1>Coding</h1><p>Projects and coding threads</p></div>
      <span className="connection" data-testid="coding-status">{status}</span>
    </header>
    {error && <p className="page-error" role="alert">{error}</p>}
    {availability === 'disabled' ? <Banner status="warning" title="engine-t3 disabled" data-testid="coding-disabled">Enable T3 from Extensions to use Coding.</Banner>
      : availability === 'not_installed' ? <Banner status="info" title="Install T3 from Extensions to use Coding." data-testid="coding-install-required" />
      : availability !== 'ready' ? <Banner status="info" title={availabilityReason} data-testid="coding-connection-required">Open Extensions to install, start or connect T3.</Banner>
      : <div className="coding-workspace">
        <aside className="coding-sidebar" aria-label="Coding projects">
          <h2>Projects</h2>
          {catalog.projects.map((entry) =>
            <button key={entry.id} type="button" className="coding-project" aria-current={projectId === entry.id ? 'page' : undefined}
              data-testid={`project-${entry.id}`} onClick={() => {
                setProjectId(entry.id);
                const preferred = providers.find((provider) => provider.id === 'neo-coding' || provider.name === 'neo-coding');
                const projectDefault = providers.find((provider) => provider.id === entry.defaultModelSelection?.instanceId);
                const chosen = preferred ?? projectDefault ?? providers[0];
                setProviderId(chosen?.id ?? '');
                setModel(chosen?.models.find((model) => model.isDefault)?.id
                  ?? chosen?.models[0]?.id ?? 'default');
                setThreadId('');
                selected.current = '';
                connection.current?.socket.close();
              }}>{entry.title}</button>)}
          {catalog.projects.length === 0 && <p>No projects yet. Add a project in your T3 workspace.</p>}
          {project && <form className="coding-create" onSubmit={(event) => void createThread(event)}>
            <h2>New thread</h2>
            <label htmlFor="coding-title">Title</label>
            <input id="coding-title" data-testid="coding-title" value={title} onChange={(event) => setTitle(event.target.value)} required />
            <label htmlFor="coding-provider">Provider</label>
            <select id="coding-provider" data-testid="coding-provider" value={providerId}
              onChange={(event) => {
                const chosen = providers.find((provider) => provider.id === event.target.value);
                setProviderId(event.target.value);
                setModel(chosen?.models.find((item) => item.isDefault)?.id ?? chosen?.models[0]?.id ?? 'default');
              }} required>
              <option value="" disabled>Select a provider</option>
              {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
            <label htmlFor="coding-model">Model</label>
            <input id="coding-model" data-testid="coding-model" value={model} onChange={(event) => setModel(event.target.value)} required />
            {a2ui.enabled && <CheckboxInput label="Interactive replies" value={interactive} onChange={setInteractive} />}
            <Button type="submit" label="Create thread" isDisabled={busy || !title.trim() || !providerId.trim()}>Create thread</Button>
          </form>}
          <h2>Threads</h2>
          {threads.map((thread: Thread) => <button type="button" key={thread.id} data-testid={`thread-${thread.id}`}
            aria-current={threadId === thread.id ? 'page' : undefined} className="coding-thread"
            onClick={() => openThread(thread.id)}>
            <strong>{thread.title}</strong><small>{thread.status}</small>
          </button>)}
        </aside>
        <div className="coding-conversation">
          {threadId ? <>
            <div className="coding-conversation-title">
              <Heading level={2}>{current?.title ?? 'Coding thread'}</Heading>
              <div className="coding-actions">
                <ButtonGroup label="Thread tools">
                  <Button label="View selected turn diff" variant="secondary" data-testid="coding-diff"
                    isDisabled={turnCount === 0} onClick={() => void showDiff()}>Diff</Button>
                  <Button label="Settle" variant="secondary" data-testid="coding-settle" onClick={() => void settle()}>Settle</Button>
                </ButtonGroup>
                {running && <Button label="Stop" variant="destructive" data-testid="coding-stop" onClick={() => void stop()}>Stop</Button>}
              </div>
            </div>
            {approval && <Card className="coding-approval" data-testid="coding-approval">
              <div className="coding-approval-content">
                <Badge variant="warning" label="Approval required" />
                <Heading level={3}>Review this coding action</Heading>
                <p>{approval.kind}</p>
                <p className="coding-muted">Request: {approval.id}</p>
                <div className="coding-actions">
                  <Button label="Deny" variant="secondary" data-testid="coding-deny" isDisabled={approval.busy}
                    onClick={() => void decide('decline')}>Deny</Button>
                  <Button label="Approve" data-testid="coding-approve" isDisabled={approval.busy}
                    onClick={() => void decide('approve')}>Approve</Button>
                </div>
              </div>
            </Card>}
            <div className="coding-thread-body">
              <div className="coding-chat">
                <ChatLayout composer={<ChatComposer value={draft} onChange={setDraft} onSubmit={(value) => void send(value)}
                  onStop={() => void stop()} isStopShown={running} placeholder="Ask the coding agent" isDisabled={busy || !subscribed} />}
                  scrollButton={null}>
              <ChatMessageList isStreaming={running} align="top" emptyState={<p>Send a prompt to start.</p>}>
                {messages.map((message) => <ChatMessage key={message.id} sender={message.role}
                  name={message.role === 'assistant' ? 'Coding agent' : 'You'}>
                  <ChatMessageBubble variant={message.role === 'assistant' ? 'ghost' : 'filled'} width="100%">
                    {message.role === 'user' ? <p>{message.text}</p> :
                      <InteractiveReply segments={a2ui.enabled && message.generation === a2ui.generation ? message.segments : undefined}
                        isBusy={busy || running || message.id !== messages.at(-1)?.id}
                        onAction={(action) => send('Submitted an interactive reply', action)}>
                        <StreamView className="coding-stream" ref={(view) => attach(message.id, view)} />
                      </InteractiveReply>}
                  </ChatMessageBubble>
                </ChatMessage>)}
              </ChatMessageList>
                </ChatLayout>
              </div>
              <aside className="coding-inspector" aria-label="Thread inspection">
                <Heading level={3}>Inspect thread</Heading>
                <div className="coding-inspector-controls">
                  <label htmlFor="coding-diff-turn">Diff for turn</label>
                  <select id="coding-diff-turn" data-testid="coding-diff-turn" value={Math.min(selectedTurn, Math.max(1, turnCount))}
                    onChange={(event) => { setSelectedTurn(Number(event.target.value)); setDiff(null); }}>
                    {Array.from({ length: turnCount }, (_, index) => <option key={index + 1} value={index + 1}>Turn {index + 1}</option>)}
                  </select>
                  {diff !== null && <div className="coding-diff">
                    <div className="coding-actions">
                      <Heading level={4}>Turn {selectedTurn} diff</Heading>
                      <Button variant="ghost" label="Close diff" onClick={() => setDiff(null)} />
                    </div>
                    <CodeBlock code={diff} isDiff isWrapped={false} maxHeight="min(36dvh, 420px)" data-testid="coding-diff-result" />
                  </div>}
                  <label htmlFor="coding-checkpoint">Checkpoint</label>
                  {checkpoints.length ? <select id="coding-checkpoint" data-testid="coding-checkpoint" value={selectedCheckpoint}
                    onChange={(event) => setSelectedCheckpoint(event.target.value)}>
                    {checkpoints.map((checkpoint) => <option key={checkpoint.id} value={checkpoint.id}>
                      Checkpoint {checkpoint.ordinalWithinScope + 1}</option>)}
                  </select> : <span data-testid="coding-checkpoint-unavailable" className="coding-muted">Not available</span>}
                  <Button label="Restore to checkpoint" variant="secondary" data-testid="coding-restore"
                    isDisabled={!selectedCheckpoint || busy || running}
                    onClick={() => setRestoreRequest({ threadId, checkpointId: selectedCheckpoint })}>Restore</Button>
                </div>
                <CodingWorkflow key={threadId} threadId={threadId} />
              </aside>
            </div>
            <AlertDialog isOpen={restoreRequest?.threadId === threadId} onOpenChange={(open) => { if (!open) setRestoreRequest(null); }}
              title="Restore conversation?" description="Restore the conversation to the selected checkpoint. Workspace files will stay as they are."
              actionLabel="Restore checkpoint" onAction={() => { if (restoreRequest) void restoreCheckpoint(restoreRequest); }} />
          </> : <div className="coding-empty">Select a thread or create one.</div>}
        </div>
      </div>}
  </section>;
}
