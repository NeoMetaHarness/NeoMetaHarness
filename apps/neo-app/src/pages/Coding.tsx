import { useEffect, useRef, useState } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type T3Event } from '@neometaharness/contracts';
import {
  Button, ChatComposer, ChatLayout, ChatMessage, ChatMessageBubble, ChatMessageList,
  StreamView, type StreamViewHandle,
} from '@neometaharness/ui';
import { gatewayUrl } from '../config';
import './coding.css';

type Client = ContractRouterClient<typeof neoContract>;
type Catalog = Awaited<ReturnType<Client['x']['engine-t3']['threads']['list']>>;
type Thread = Catalog['threads'][number];
type Message = { id: number; role: 'user' | 'assistant'; text?: string };
type Approval = { id: string; kind: string; busy: boolean };
const http = createORPCClient<Client>(new HttpLink({ url: gatewayUrl() }));

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
  const [model, setModel] = useState('default');
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const live = useRef(true);
  const connection = useRef<{ threadId: string; socket: WebSocket } | null>(null);
  const selected = useRef('');
  const views = useRef(new Map<number, StreamViewHandle>());
  const queued = useRef(new Map<number, string>());
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

  async function refresh(silent = false) {
    try {
      const result = await http.x['engine-t3'].threads.list();
      if (!live.current) return;
      setCatalog(result);
      setProjectId((previous) => result.projects.some((project) => project.id === previous)
        ? previous : result.projects[0]?.id ?? '');
      const firstProject = result.projects[0];
      if (firstProject) {
        setProviderId((previous) => previous || firstProject.defaultModelSelection?.instanceId || '');
        setModel((previous) => previous === 'default' ? firstProject.defaultModelSelection?.model ?? previous : previous);
      }
      setStatus((previous) => previous === 'disabled' ? 'Ready' : previous === 'Loading' ? 'Ready' : previous);
      if (!silent) setError('');
    } catch (reason) {
      if (!live.current) return;
      if (isDisabled(reason)) {
        setStatus('disabled');
        setError('');
        setCatalog({ projects: [], threads: [] });
        connection.current?.socket.close();
        connection.current = null;
        setRunning(false);
      } else if (!silent) {
        setError(`Cannot load coding projects: ${String(reason)}`);
        setStatus('Unavailable');
      }
    }
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
      append(messageId, event.textDelta ?? '');
      return;
    }
    if (event.kind !== 'event') return;
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
    setRunning(false);
    setError('');
    setStatus('Connecting');
    activeAssistant.current = null;
    messageIds.current.clear();
    queued.current.clear();
    views.current.clear();
    const socket = new WebSocket(gatewayUrl().replace(/^http/, 'ws') + '/ws');
    connection.current = { socket, threadId: id };
    const client = createORPCClient<Client>(new WebSocketLink({ websocket: socket }));
    void (async () => {
      try {
        for await (const event of await client.x['engine-t3'].events({ threadId: id })) {
          if (selected.current !== id) break;
          receive(id, event);
        }
      } catch (reason) {
        if (live.current && selected.current === id && connection.current?.socket === socket) {
          setStatus(isDisabled(reason) ? 'disabled' : 'Unavailable');
          if (!isDisabled(reason)) setError(`Stream interrupted: ${String(reason)}`);
        }
      } finally {
        socket.close();
        if (connection.current?.socket === socket) connection.current = null;
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
      await http.x['engine-t3'].create({
        threadId: id, projectId, title: title.trim(), providerId: providerId.trim(), model: model.trim(),
      });
      await refresh();
      openThread(id);
      setTitle('');
    } catch (reason) {
      setError(`Could not create thread: ${String(reason)}`);
    } finally {
      setBusy(false);
    }
  }

  async function send(text: string) {
    const input = text.trim();
    if (!threadId || !subscribed || !input || running || busy || status === 'disabled') return;
    setBusy(true);
    setError('');
    setDraft('');
    setStatus('Running');
    setRunning(true);
    // Some adapters reuse message ids between turns. Bind each turn's ids to its own stream.
    messageIds.current.clear();
    const assistantId = ++nextId.current;
    activeAssistant.current = assistantId;
    setMessages((previous) => [...previous,
      { id: ++nextId.current, role: 'user', text: input },
      { id: assistantId, role: 'assistant' },
    ]);
    try {
      await http.x['engine-t3'].send({ threadId, text: input });
    } catch (reason) {
      setRunning(false);
      setStatus(isDisabled(reason) ? 'disabled' : 'Failed');
      setError(`Could not send prompt: ${String(reason)}`);
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
      const result = await http.x['engine-t3'].diff({ threadId, fromTurnCount: 0, toTurnCount: 1 });
      setDiff(result.diff || 'No changes');
    } catch {
      setDiff('Diff not available');
    }
  }

  const project = catalog.projects.find((entry) => entry.id === projectId);
  const threads = catalog.threads.filter((thread) => thread.projectId === projectId);
  const current = catalog.threads.find((thread) => thread.id === threadId);
  return <section className="coding-page" data-testid="coding-page">
    <header className="page-header">
      <div><h1>Coding</h1><p>Projects and coding threads</p></div>
      <span className="connection" data-testid="coding-status">{status}</span>
    </header>
    {error && <p className="page-error" role="alert">{error}</p>}
    {status === 'disabled' ? <p role="status" data-testid="coding-disabled">engine-t3 disabled</p>
      : <div className="coding-workspace">
        <aside className="coding-sidebar" aria-label="Coding projects">
          <h2>Projects</h2>
          {catalog.projects.map((entry) =>
            <button key={entry.id} type="button" className="coding-project" aria-current={projectId === entry.id ? 'page' : undefined}
              data-testid={`project-${entry.id}`} onClick={() => {
                setProjectId(entry.id);
                setProviderId(entry.defaultModelSelection?.instanceId ?? '');
                setModel(entry.defaultModelSelection?.model ?? 'default');
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
            <input id="coding-provider" data-testid="coding-provider" value={providerId}
              onChange={(event) => setProviderId(event.target.value)} placeholder="Provider instance" required />
            <label htmlFor="coding-model">Model</label>
            <input id="coding-model" data-testid="coding-model" value={model} onChange={(event) => setModel(event.target.value)} required />
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
              <h2>{current?.title ?? 'Coding thread'}</h2>
              <div className="coding-actions">
                <Button label="View first-turn diff" variant="secondary" data-testid="coding-diff" onClick={() => void showDiff()}>Diff</Button>
                <Button label="Settle" variant="secondary" data-testid="coding-settle" onClick={() => void settle()}>Settle</Button>
                {running && <Button label="Stop" data-testid="coding-stop" onClick={() => void stop()}>Stop</Button>}
              </div>
            </div>
            {diff !== null && <pre className="coding-diff" data-testid="coding-diff-result">{diff}</pre>}
            <ChatLayout composer={<ChatComposer value={draft} onChange={setDraft} onSubmit={(value) => void send(value)}
              onStop={() => void stop()} isStopShown={running} placeholder="Ask the coding agent" isDisabled={busy || !subscribed} />}
              scrollButton={null}>
              <ChatMessageList isStreaming={running} align="top" emptyState={<p>Send a prompt to start.</p>}>
                {messages.map((message) => <ChatMessage key={message.id} sender={message.role}
                  name={message.role === 'assistant' ? 'Coding agent' : 'You'}>
                  <ChatMessageBubble variant={message.role === 'assistant' ? 'ghost' : 'filled'} width="100%">
                    {message.role === 'user' ? <p>{message.text}</p> :
                      <StreamView className="coding-stream" ref={(view) => attach(message.id, view)} />}
                    {message.role === 'assistant' && approval && message.id === messages.at(-1)?.id &&
                      <div className="coding-approval" data-testid="coding-approval">
                        <strong>Approval required</strong><p>{approval.kind}</p>
                        <Button label="Approve" data-testid="coding-approve" isDisabled={approval.busy}
                          onClick={() => void decide('approve')}>Approve</Button>
                        <Button label="Deny" variant="secondary" data-testid="coding-deny" isDisabled={approval.busy}
                          onClick={() => void decide('decline')}>Deny</Button>
                      </div>}
                  </ChatMessageBubble>
                </ChatMessage>)}
              </ChatMessageList>
            </ChatLayout>
          </> : <div className="coding-empty">Select a thread or create one.</div>}
        </div>
      </div>}
  </section>;
}
