import { useEffect, useRef, useState } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type HermesEvent } from '@neometaharness/contracts';
import {
  Button, ChatComposer, ChatLayout, ChatMessage, ChatMessageBubble, ChatMessageList,
  StreamView, type StreamViewHandle,
} from '@neometaharness/ui';
import { gatewayUrl, gatewayToken } from '../config';
import './agents.css';

type Client = ContractRouterClient<typeof neoContract>;
type Bot = { name: string; path: string };
type Turn = { id: number; role: 'user' | 'assistant'; text?: string; steps: string[] };
type ApprovalChoice = 'once' | 'session' | 'deny';
type ActiveRun = {
  profile: string;
  runId?: string;
  turnId: number;
  socket?: WebSocket;
  stopped: boolean;
};

const http = createORPCClient<Client>(
  new HttpLink({
    url: gatewayUrl(),
    headers: () => {
      const token = gatewayToken();
      return token ? { authorization: `Bearer ${token}` } : {};
    },
  })
);
const terminal = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted']);

function describeEvent(event: HermesEvent): string {
  const payload = event.payload;
  if (!payload || typeof payload !== 'object') return event.type ?? 'Step';
  const details = payload as Record<string, unknown>;
  const label = details.tool_name ?? details.tool ?? details.step ?? details.name;
  return typeof label === 'string' ? label : (event.type ?? 'Step');
}

export default function Agents() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [status, setStatus] = useState('Ready');
  const [approval, setApproval] = useState<{ busy: boolean; detail: string } | null>(null);
  const [error, setError] = useState('');
  const active = useRef<ActiveRun | null>(null);
  const mounted = useRef(true);
  const nextTurn = useRef(0);
  const streams = useRef(new Map<number, StreamViewHandle>());
  const queued = useRef(new Map<number, string>());
  const pendingRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      active.current?.socket?.close();
      active.current = null;
    };
  }, []);

  async function refresh() {
    try {
      const response = await http.x['engine-hermes'].profiles.list();
      if (mounted.current) setBots(response.profiles);
    } catch (reason) {
      if (mounted.current) setError(`Could not load bots: ${String(reason)}`);
    }
  }

  async function createBot(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const created = await http.x['engine-hermes'].profiles.create({ name: name.trim() });
      await refresh();
      openBot(created.name);
      setName('');
    } catch (reason) {
      setError(`Could not create bot: ${String(reason)}`);
    } finally {
      setBusy(false);
    }
  }

  function openBot(profile: string) {
    if (pendingRef.current) return;
    setSelected(profile);
    setTurns([]);
    setApproval(null);
    setStatus('Ready');
    setError('');
    streams.current.clear();
    queued.current.clear();
  }

  async function deleteBot(profile: string) {
    if (busy || pendingRef.current || profile === 'default') return;
    setBusy(true);
    setError('');
    try {
      await http.x['engine-hermes'].profiles.delete({ name: profile });
      if (selected === profile) {
        setSelected(null);
        setTurns([]);
      }
      await refresh();
    } catch (reason) {
      setError(`Could not delete bot: ${String(reason)}`);
    } finally {
      setBusy(false);
    }
  }

  function appendText(id: number, delta: string) {
    const view = streams.current.get(id);
    if (view) view.append(delta);
    else queued.current.set(id, (queued.current.get(id) ?? '') + delta);
  }

  function attachStream(id: number, view: StreamViewHandle | null) {
    if (!view) {
      streams.current.delete(id);
      return;
    }
    streams.current.set(id, view);
    const delta = queued.current.get(id);
    if (delta) {
      view.append(delta);
      queued.current.delete(id);
    }
  }

  function receiveEvent(run: ActiveRun, event: HermesEvent) {
    if (active.current !== run || !mounted.current) return;
    if (event.kind === 'text.delta') {
      appendText(run.turnId, event.textDelta ?? '');
      return;
    }
    const type = event.type ?? '';
    if (type === 'approval.request') {
      setApproval({ busy: false, detail: describeEvent(event) });
      setStatus('Approval required');
    } else if (terminal.has(type)) {
      setStatus(type === 'run.completed' ? 'Completed'
        : type === 'run.cancelled' || type === 'run.interrupted' ? 'Cancelled' : 'Failed');
      setApproval(null);
    } else if (/tool|step/i.test(type)) {
      const label = describeEvent(event);
      setTurns((previous) => previous.map((turn) =>
        turn.id === run.turnId && !turn.steps.includes(label)
          ? { ...turn, steps: [...turn.steps, label] } : turn));
    }
  }

  async function send(value: string) {
    const input = value.trim();
    if (!selected || !input || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setStatus('Starting');
    setError('');
    setApproval(null);
    setDraft('');
    const userId = ++nextTurn.current;
    const assistantId = ++nextTurn.current;
    const run: ActiveRun = { profile: selected, turnId: assistantId, stopped: false };
    active.current = run;
    setTurns((previous) => [
      ...previous,
      { id: userId, role: 'user', text: input, steps: [] },
      { id: assistantId, role: 'assistant', steps: [] },
    ]);
    try {
      const started = await http.x['engine-hermes'].runs.start({ profile: selected, input });
      if (active.current !== run) return;
      run.runId = started.run_id;
      setStatus('Running');
      const token = gatewayToken();
      const wsUrl = gatewayUrl().replace(/^http/, 'ws') + '/ws';
      run.socket = token ? new WebSocket(wsUrl, ['bearer.' + token]) : new WebSocket(wsUrl);
      const ws = createORPCClient<Client>(new WebSocketLink({ websocket: run.socket }));
      for await (const event of await ws.x['engine-hermes'].runs.events({
        profile: run.profile, runId: started.run_id,
      })) {
        receiveEvent(run, event);
        if (terminal.has(event.type ?? '')) break;
      }
      if (!run.stopped && active.current === run) {
        setStatus((previous) => ['Completed', 'Cancelled', 'Failed'].includes(previous) ? previous : 'Completed');
      }
    } catch (reason) {
      if (!run.stopped && active.current === run && mounted.current) {
        setStatus('Failed');
        setError(`Run failed: ${String(reason)}`);
      }
    } finally {
      if (active.current === run && mounted.current) {
        streams.current.get(assistantId)?.finish();
        active.current = null;
        pendingRef.current = false;
        setPending(false);
        setApproval(null);
      }
      run.socket?.close();
    }
  }

  async function approve(choice: ApprovalChoice) {
    const run = active.current;
    if (!run?.runId || !approval || approval.busy) return;
    setApproval({ ...approval, busy: true });
    try {
      await http.x['engine-hermes'].runs.approve({ profile: run.profile, runId: run.runId, choice });
      if (active.current === run) {
        setApproval(null);
        setStatus('Running');
      }
    } catch (reason) {
      setError(`Approval failed: ${String(reason)}`);
      setApproval((previous) => previous && { ...previous, busy: false });
    }
  }

  async function stop() {
    const run = active.current;
    if (!run?.runId || run.stopped) return;
    run.stopped = true;
    setStatus('Stopping');
    setApproval(null);
    try {
      const result = await http.x['engine-hermes'].runs.stop({ profile: run.profile, runId: run.runId });
      if (active.current === run) {
        setStatus(['cancelled', 'interrupted'].includes(result.status) ? 'Cancelled' : result.status);
        run.socket?.close();
      }
    } catch (reason) {
      run.stopped = false;
      setStatus('Running');
      setError(`Stop failed: ${String(reason)}`);
    }
  }

  return <section className="agents-page" data-testid="agents-page">
    <header className="page-header">
      <div><h1>Agents</h1><p>Create a bot and work with it in chat.</p></div>
      <span className="connection" data-testid="agents-status">{status}</span>
    </header>
    {error && <p className="page-error" role="alert">{error}</p>}
    <div className="agents-workspace">
      <aside className="agents-sidebar" aria-label="Bots">
        <form onSubmit={(event) => void createBot(event)} className="agents-create">
          <label htmlFor="bot-name">New bot</label>
          <div className="agents-create-controls">
            <input id="bot-name" data-testid="bot-name" value={name}
              onChange={(event) => setName(event.target.value)} placeholder="bot_name"
              pattern="[a-z][a-z0-9_-]{0,47}" required disabled={busy} />
            <Button label="Create" type="submit" isDisabled={busy || !name.trim()}>Create</Button>
          </div>
        </form>
        <h2>My bots</h2>
        <div className="agents-bot-list">
          {bots.map((bot) => <div className="agents-bot-row" key={bot.name} data-testid={`bot-${bot.name}`}>
            <button type="button" aria-current={selected === bot.name ? 'page' : undefined}
              className="agents-bot-open" onClick={() => openBot(bot.name)}
              disabled={pending} data-testid={`open-${bot.name}`}>{bot.name}</button>
            {bot.name !== 'default' && <Button label="Delete" size="sm" variant="secondary"
              onClick={() => void deleteBot(bot.name)} isDisabled={busy || pending}
              data-testid={`delete-${bot.name}`}>Delete</Button>}
          </div>)}
        </div>
      </aside>
      <div className="agents-conversation">
        {selected ? <>
          <div className="agents-conversation-title"><h2>{selected}</h2><span>Hermes</span>{pending && <Button label="Stop" data-testid="stop-run" onClick={() => void stop()} />}</div>
          <ChatLayout composer={<ChatComposer
            value={draft} onChange={setDraft} onSubmit={(value) => void send(value)}
            onStop={() => void stop()} isStopShown={pending}
            placeholder={`Message ${selected}`} isDisabled={busy}
          />} scrollButton={null}>
            <ChatMessageList isStreaming={pending} align="top" emptyState={<p>Send a message to begin.</p>}>
              {turns.map((turn) => <ChatMessage key={turn.id} sender={turn.role}
                name={turn.role === 'assistant' ? selected : 'You'}>
                <ChatMessageBubble variant={turn.role === 'assistant' ? 'ghost' : 'filled'} width="100%">
                  {turn.role === 'user' ? <p>{turn.text}</p>
                    : <StreamView className="agents-stream" ref={(view) => attachStream(turn.id, view)} />}
                  {turn.steps.length > 0 && <div className="agents-steps" aria-label="Tool steps">
                    {turn.steps.map((step) => <span className="agents-chip" key={step}>{step}</span>)}
                  </div>}
                  {turn.role === 'assistant' && approval && active.current?.turnId === turn.id &&
                    <div className="agents-approval" data-testid="approval-card">
                      <strong>Approval required</strong>
                      <p>{approval.detail}</p>
                      <div className="agents-approval-actions">
                        <Button label="Allow once" isDisabled={approval.busy} onClick={() => void approve('once')}>Allow once</Button>
                        <Button label="Allow session" isDisabled={approval.busy} onClick={() => void approve('session')}>Allow session</Button>
                        <Button label="Deny" isDisabled={approval.busy} variant="secondary"
                          onClick={() => void approve('deny')} data-testid="approval-deny">Deny</Button>
                      </div>
                    </div>}
                </ChatMessageBubble>
              </ChatMessage>)}
            </ChatMessageList>
          </ChatLayout>
        </> : <div className="agents-empty"><h2>Select a bot</h2><p>Choose a bot or create one to start chatting.</p></div>}
      </div>
    </div>
  </section>;
}
