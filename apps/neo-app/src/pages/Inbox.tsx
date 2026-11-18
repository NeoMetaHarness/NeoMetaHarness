import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type InboxItem } from '@neometaharness/contracts';
import { Button } from '@neometaharness/ui';
import { gatewayUrl } from '../config';
import './inbox.css';

type Client = ContractRouterClient<typeof neoContract>;
const http = createORPCClient<Client>(new HttpLink({ url: gatewayUrl() }));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function textNode(tag: string, content: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = content;
  if (className) element.className = className;
  return element;
}

export default function Inbox() {
  const [bots, setBots] = useState<{ id: string; name: string }[]>([]);
  const [botId, setBotId] = useState('');
  const [mode, setMode] = useState<'observe' | 'act'>('observe');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [connection, setConnection] = useState('Connecting');
  const [error, setError] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const latest = useRef(0);
  const gatewayCursor = useRef(0);
  const active = useRef(true);

  // The live event path updates individual DOM rows. React renders only form and connection state.
  function renderItem(item: InboxItem) {
    if (!active.current || !list.current) return;
    let row = rows.current.get(item.id);
    if (!row) {
      row = document.createElement('article');
      row.className = 'inbox-item';
      row.dataset.testid = `inbox-${item.id}`;
      rows.current.set(item.id, row);
      list.current.prepend(row);
    }
    row.dataset.status = item.status;
    const header = document.createElement('div');
    header.className = 'inbox-item-header';
    header.append(textNode('span', item.mode === 'observe' ? 'Observe' : 'Act', 'inbox-mode'),
      textNode('strong', item.status, 'inbox-status'));
    const body = textNode('p', item.text, 'inbox-request');
    const content: HTMLElement[] = [header, body];
    if (item.status === 'suggestion') {
      const accept = document.createElement('button');
      accept.type = 'button';
      accept.className = 'inbox-accept';
      accept.textContent = 'Accept';
      accept.dataset.action = 'accept';
      accept.onclick = async () => {
        accept.disabled = true;
        setError('');
        try { renderItem(await http.inbox.accept({ id: item.id })); }
        catch (reason) { setError(`Could not accept suggestion: ${String(reason)}`); accept.disabled = false; }
      };
      content.push(accept);
    }
    if (item.report) {
      const report = document.createElement('section');
      report.className = 'inbox-report';
      report.dataset.testid = 'inbox-report';
      report.append(textNode('h3', 'Report'), textNode('p', item.report.summary, 'inbox-summary'));
      for (const [title, entries] of [['Tests run', item.report.tests], ['Risks', item.report.risks]] as const) {
        const group = document.createElement('div');
        group.className = 'inbox-report-group';
        group.append(textNode('strong', title));
        if (!entries.length) group.append(textNode('p', 'None reported'));
        else {
          const bullets = document.createElement('ul');
          for (const entry of entries) bullets.append(textNode('li', entry));
          group.append(bullets);
        }
        report.append(group);
      }
      content.push(report);
      if (item.status === 'blocked') content.push(textNode('p', item.report.risks[0] ?? item.report.summary, 'inbox-blocked'));
    }
    row.replaceChildren(...content);
  }

  useEffect(() => {
    active.current = true;
    let closed = false;
    let socket: WebSocket | undefined;
    const setStatus = async () => {
      const extensions = await http.extensions.list();
      const running = extensions.some((entry) => entry.id === 'engine-superagent' && entry.status === 'running');
      if (!closed) setEnabled(running);
      return running;
    };
    void http.agents.bots.list().then((result) => {
      if (!closed) {
        setBots(result);
        setBotId((previous) => previous || result[0]?.id || '');
      }
    }).catch((reason) => { if (!closed) setError(`Could not load bots: ${String(reason)}`); });
    void setStatus().catch((reason) => { if (!closed) setError(`Gateway unavailable: ${String(reason)}`); });

    async function refresh() {
      const items = await http.inbox.list();
      if (closed || !list.current) return;
      rows.current.clear();
      list.current.replaceChildren();
      for (const item of items.sort((a, b) => a.createdAt - b.createdAt)) renderItem(item);
    }
    async function listen() {
      while (!closed) {
        socket = new WebSocket(gatewayUrl().replace(/^http/, 'ws') + '/ws');
        const ws = socket;
        let stateChange = false;
        try {
          await new Promise<void>((resolve, reject) => {
            ws.addEventListener('open', () => resolve(), { once: true });
            ws.addEventListener('error', () => reject(new Error('Inbox socket unavailable')), { once: true });
          });
          if (closed) break;
          const live = createORPCClient<Client>(new WebSocketLink({ websocket: ws }));
          const running = await setStatus();
          if (running) await refresh();
          latest.current = 0;
          if (!closed) setConnection('Live');
          await Promise.all([
            ...(running ? [(async () => {
              for await (const event of await live.inbox.events({ since: latest.current })) {
                if (closed) break;
                if (event.seq > latest.current) {
                  latest.current = event.seq;
                  renderItem(event.item);
                }
              }
            })()] : []),
            (async () => {
              for await (const event of await live.events.subscribe({ since: gatewayCursor.current })) {
                if (closed) break;
                if (event.seq <= gatewayCursor.current) continue;
                gatewayCursor.current = event.seq;
                if (event.type === 'extension.state' && event.extensionId === 'engine-superagent') {
                  if ((event.status === 'running') !== running) {
                    setEnabled(event.status === 'running');
                    // A restarted extension has a new event stream. Rebind the subscription.
                    stateChange = true;
                    throw new Error('Superagent state changed');
                  }
                }
              }
            })(),
          ]);
        } catch (reason) {
          if (!closed) setConnection(`Reconnecting: ${String(reason)}`);
        } finally {
          // Gateway restarts reset event sequence numbers.
          if (!stateChange) gatewayCursor.current = 0;
          ws.close();
        }
        if (!closed) await sleep(400);
      }
    }
    void listen();
    return () => { closed = true; active.current = false; socket?.close(); rows.current.clear(); };
  }, []);

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim() || !botId || busy || !enabled) return;
    setBusy(true);
    setError('');
    try {
      renderItem(await http.inbox.ask({ text: draft.trim(), botId, mode }));
      setDraft('');
    } catch (reason) { setError(`Ask Neo failed: ${String(reason)}`); }
    finally { setBusy(false); }
  }

  return <section className="inbox-page" aria-label="Inbox">
    <header className="page-header">
      <div><h1>Inbox</h1><p>Ask Neo to coordinate work across your agents.</p></div>
      <span className="connection" role="status">{connection}</span>
    </header>
    {!enabled && <p className="page-error" role="status" data-testid="inbox-disabled">Superagent extension is disabled. Enable it on Extensions to use Ask Neo.</p>}
    {error && <p role="alert" className="page-error">{error}</p>}
    <form className="inbox-composer" onSubmit={(event) => { void ask(event); }}>
      <label htmlFor="inbox-prompt">Ask Neo</label>
      <textarea id="inbox-prompt" rows={3} placeholder="What should Neo work on?" value={draft}
        onChange={(event) => setDraft(event.target.value)} disabled={!enabled || busy} />
      <div className="inbox-controls">
        <label>Agent <select aria-label="Agent" value={botId} onChange={(event) => setBotId(event.target.value)} disabled={!enabled || busy}>
          {!bots.length && <option value="">Create an agent first</option>}
          {bots.map((bot) => <option value={bot.id} key={bot.id}>{bot.name}</option>)}
        </select></label>
        <fieldset className="inbox-modes"><legend>Mode</legend>
          <label><input type="radio" name="mode" value="observe" checked={mode === 'observe'} onChange={() => setMode('observe')} />Observe</label>
          <label><input type="radio" name="mode" value="act" checked={mode === 'act'} onChange={() => setMode('act')} />Act</label>
        </fieldset>
        <Button type="submit" label={busy ? 'Sending…' : 'Ask Neo'} isDisabled={!enabled || !botId || !draft.trim() || busy} />
      </div>
    </form>
    <div className="inbox-items" aria-label="Inbox items" ref={list} />
  </section>;
}
