import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type AcceptMode, type InboxItem } from '@neometaharness/contracts';
import { createPortal } from 'react-dom';
import { Banner, Button, TextArea, TextInput, Switch, SegmentedControl, SegmentedControlItem, Selector } from '@neometaharness/ui';
import { gatewayUrl, gatewayToken } from '../config';
import EngineInstall from './EngineInstall';
import './inbox.css';

type Client = ContractRouterClient<typeof neoContract>;
const http = createORPCClient<Client>(new HttpLink({
  url: gatewayUrl(),
  headers: () => {
    const token = gatewayToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  },
}));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function textNode(tag: string, content: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = content;
  if (className) element.className = className;
  return element;
}

type ControlItem = Pick<InboxItem, 'id' | 'status' | 'source' | 'botId' | 'destructive'> & {
  question: string;
  approvalReason: string;
  approvalDestructive: boolean;
};
type ControlEntry = { host: HTMLElement; item: ControlItem };

function InboxControls({ item, onResult, onError }: {
  item: ControlItem;
  onResult: (item: InboxItem) => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const upstream = item.source === 'neo/upstream';
  const run = async (label: string, call: () => Promise<InboxItem>) => {
    setBusy(true);
    onError('');
    try { onResult(await call()); }
    catch (error) { onError(`Could not ${label}: ${String(error)}`); }
    finally { setBusy(false); }
  };
  const accept = () => void run('accept suggestion', () => http.inbox.accept({ id: item.id }));
  const decide = (decision: 'approve' | 'deny') => {
    if (!draft.trim()) { reasonField.current?.reportValidity(); return; }
    void run(decision, () => http.inbox.approval.decide({ id: item.id, decision, reason: draft.trim() }));
  };
  return <>
    {item.status === 'suggestion' && <div className="inbox-suggestion" data-testid="inbox-suggestion">
      {upstream ? <Banner status="warning" title={item.botId === 'neo-system'
        ? 'Configure a bot for upstream work to approve this bump'
        : 'Upgrade: an admin must approve; the bot bumps on a branch and reports'} />
        : item.destructive && <Banner status="warning" title="Destructive: an admin must accept" />}
      {(!upstream || item.botId !== 'neo-system') && <Button label={upstream ? 'Approve bump' : 'Accept'}
        data-action="accept" isDisabled={busy} variant={item.destructive ? 'destructive' : 'primary'}
        onClick={accept} />}
      <Button label="Dismiss" data-action="dismiss" variant="secondary" isDisabled={busy}
        onClick={() => void run('dismiss suggestion', () => http.inbox.dismiss({ id: item.id }))} />
    </div>}
    {item.status === 'question' && <form className="inbox-response" data-testid="inbox-question" onSubmit={event => {
      event.preventDefault();
      if (!busy && draft.trim()) void run('reply', () => http.inbox.reply({ id: item.id, answer: draft.trim() }));
    }}>
      <TextArea label={item.question} value={draft} onChange={setDraft} isRequired isDisabled={busy}
        ref={el => { if (el) { el.name = 'answer'; el.required = true; el.setAttribute('aria-label', 'Answer question'); } }} rows={3} />
      <Button type="submit" label="Reply" data-action="reply" isDisabled={busy} />
    </form>}
    {item.status === 'approval' && <div className="inbox-response" data-testid="inbox-approval">
      <Banner status="warning" title={item.approvalDestructive ? 'Admin approval required' : 'Approval requested'} description={item.approvalReason} />
      <TextArea label="Reason" value={draft} onChange={setDraft} isRequired isDisabled={busy}
        ref={el => { reasonField.current = el; if (el) { el.name = 'reason'; el.required = true; el.setAttribute('aria-label', 'Approval reason'); } }} rows={3} />
      <div className="inbox-suggestion">
        <Button label="Deny" data-action="deny" variant="secondary" isDisabled={busy} onClick={() => decide('deny')} />
        <Button label="Approve" data-action="approve" variant={item.approvalDestructive ? 'destructive' : 'primary'}
          isDisabled={busy} onClick={() => decide('approve')} />
      </div>
    </div>}
    {item.status === 'failed' && <Button label="Retry" data-action="retry" variant="secondary" isDisabled={busy}
      onClick={() => void run('retry', () => http.inbox.retry({ id: item.id }))} />}
  </>;
}

export default function Inbox() {
  const [bots, setBots] = useState<{ id: string; name: string }[]>([]);
  const [botId, setBotId] = useState('');
  const [mode, setMode] = useState<'observe' | 'act'>('observe');
  const [draft, setDraft] = useState('');
  const [notify, setNotify] = useState(false);
  const [notifyProfile, setNotifyProfile] = useState('');
  const [notifyNumber, setNotifyNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  /** engine-superagent runs in install mode (P7-16): offer the install instead of the Inbox. */
  const [notInstalled, setNotInstalled] = useState(false);
  /** Bumped after an install from this page, to reconnect to the started Inbox. */
  const [round, setRound] = useState(0);
  const [connection, setConnection] = useState('Connecting');
  const [error, setError] = useState('');
  const [acceptMode, setAcceptMode] = useState<AcceptMode | ''>('');
  const list = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const [controls, setControls] = useState<Record<string, ControlEntry>>({});
  const latest = useRef(0);
  const gatewayCursor = useRef(0);
  const active = useRef(true);

  // The live event path updates individual DOM rows. React renders only form and connection state.
  function renderItem(item: InboxItem) {
    if (!active.current || !list.current) return;
    let row = rows.current.get(item.id);
    // A reconnect lists current items before replaying historical events.
    // Ignore older snapshots so a previous status cannot unmount a live draft.
    if (row && Number(row.dataset.updatedAt) > item.updatedAt) return;
    if (!row) {
      row = document.createElement('article');
      row.className = 'inbox-item';
      row.dataset.testid = `inbox-${item.id}`;
      for (const region of ['content', 'controls', 'report']) {
        const host = document.createElement('div');
        host.dataset.region = region;
        row.append(host);
      }
      rows.current.set(item.id, row);
      list.current.prepend(row);
    }
    row.dataset.status = item.status;
    row.dataset.updatedAt = String(item.updatedAt);
    if (!row.dataset.deepLinkSelected && new URLSearchParams(window.location.search).get('openInbox') === item.id) {
      row.dataset.deepLinkSelected = 'true';
      requestAnimationFrame(() => row?.scrollIntoView({ block: 'center' }));
    }
    const header = document.createElement('div');
    header.className = 'inbox-item-header';
    header.append(textNode('span', item.mode === 'observe' ? 'Observe' : 'Act', 'inbox-mode'),
      textNode('strong', item.status, 'inbox-status'));
    const body = textNode('p', item.text, 'inbox-request');
    const content: HTMLElement[] = [header, body];
    if (item.upstream) {
      const details = document.createElement('section');
      details.className = 'inbox-upstream';
      details.dataset.testid = 'inbox-upstream';
      details.append(textNode('p', `Engine: ${item.upstream.name}`),
        textNode('p', `Current pin: ${item.upstream.pinned}`),
        textNode('p', `Latest upstream: ${item.upstream.latest}`));
      if (item.upstream.changelog) {
        const link = document.createElement('a');
        link.href = item.upstream.changelog;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Changelog';
        details.append(link);
      }
      content.push(details);
    }
    const contentHost = row.children[0] as HTMLElement;
    const controlsHost = row.children[1] as HTMLElement;
    const reportHost = row.children[2] as HTMLElement;
    contentHost.replaceChildren(...content);
    content.length = 0;
    // The portal stays mounted through same-status events and reconnect snapshots.
    const controlItem: ControlItem = {
      id: item.id, status: item.status, source: item.source, botId: item.botId,
      destructive: item.destructive,
      question: item.report?.question || item.report?.summary || 'Your answer',
      approvalReason: item.approval?.reason || 'Approval requested',
      approvalDestructive: !!item.approval?.destructive,
    };
    setControls(previous => {
      const entry = previous[item.id];
      if (!['suggestion', 'question', 'approval', 'failed'].includes(item.status)) {
        if (!entry) return previous;
        const next = { ...previous }; delete next[item.id]; return next;
      }
      if (entry?.host === controlsHost && JSON.stringify(entry.item) === JSON.stringify(controlItem)) return previous;
      return { ...previous, [item.id]: { host: controlsHost, item: controlItem } };
    });
    if (item.report) {
      const report = document.createElement('section');
      report.className = 'inbox-report';
      report.dataset.testid = 'inbox-report';
      if (item.notification) content.push(textNode('p', item.notification.deliveredAt ? 'WhatsApp notification sent' : item.notification.error ?? 'WhatsApp notification pending', 'inbox-notification'));
      report.append(textNode('h3', 'Report'), textNode('p', item.report.summary, 'inbox-summary'));
      if (item.report.postmortem) {
        const review = item.report.postmortem;
        const section = document.createElement('div');
        section.className = 'inbox-report-group';
        section.dataset.testid = 'inbox-postmortem';
        section.append(textNode('strong', 'Post-mortem'),
          textNode('p', `What worked: ${review.worked}`),
          textNode('p', `What failed: ${review.failed}`),
          textNode('p', review.reusable ? 'Reusable procedure suggested' : 'No reusable procedure identified'));
        if (review.procedure) section.append(textNode('p', review.procedure));
        if (review.skill) section.append(textNode('p', `Skill proposal: ${review.skill}`));
        report.append(section);
      }
      if (item.report.playbook) {
        const playbook = item.report.playbook;
        const section = document.createElement('div');
        section.className = 'inbox-report-group';
        section.dataset.testid = 'inbox-playbook';
        section.append(textNode('strong', 'Playbook suggestion'),
          textNode('p', `Skill: ${playbook.skill}`),
          textNode('p', `Evidence: ${playbook.tickets.length} successful episodes`),
          textNode('p', 'Review and assign this untrusted skill in the Skills Registry.'));
        report.append(section);
      }
      if (item.episode) {
        const section = document.createElement('div');
        section.className = 'inbox-report-group';
        section.dataset.testid = 'inbox-episode';
        section.append(textNode('strong', 'Episode'),
          textNode('p', `Goal: ${item.episode.goal}`),
          textNode('p', `Outcome: ${item.episode.outcome}`),
          textNode('p', `Steps: ${item.episode.steps.join(' → ')}`),
          textNode('p', `Tools: ${item.episode.tools.join(', ') || 'None'}`),
          textNode('p', `Trace: ${item.episode.traceId}`));
        report.append(section);
      }
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
    reportHost.replaceChildren(...content);
  }

  useEffect(() => {
    active.current = true;
    let closed = false;
    let socket: WebSocket | undefined;
    /** True when the Inbox can be used: engine-superagent is running and installed (P7-16 install mode is not). */
    const setStatus = async () => {
      const extensions = await http.extensions.list();
      const running = extensions.some((entry) => entry.id === 'engine-superagent' && entry.status === 'running');
      // While restarting after an install its routes are briefly absent; that counts as not ready yet.
      const ready = running && await http.x['engine-superagent'].install.status().then((status) => status.state === 'ready', () => false);
      if (!closed) { setEnabled(ready); setNotInstalled(running && !ready); }
      if (ready) void http.inbox.acceptMode.get().then(({ mode }) => { if (!closed) setAcceptMode(mode); }).catch(() => {});
      return ready;
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
      const ids = new Set(items.map(item => item.id));
      for (const [id, row] of rows.current) {
        if (!ids.has(id)) { row.remove(); rows.current.delete(id); }
      }
      setControls(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => ids.has(id))));
      for (const item of items.sort((a, b) => a.createdAt - b.createdAt)) renderItem(item);
    }
    async function listen() {
      while (!closed) {
        {
          const token = gatewayToken();
          socket = new WebSocket(gatewayUrl().replace(/^http/, 'ws') + '/ws', token ? ['bearer.' + token] : undefined);
        }
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
                  // Running alone is not enough: an extension in install mode runs without the Inbox.
                  if (await setStatus() !== running) {
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
    return () => { closed = true; active.current = false; socket?.close(); };
  }, [round]);

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim() || !botId || busy || !enabled) return;
    setBusy(true);
    setError('');
    try {
      renderItem(await http.inbox.ask({ text: draft.trim(), botId, mode, ...(notify ? { notify: { profile: notifyProfile.trim(), senderId: notifyNumber.trim() } } : {}) }));
      setDraft('');
    } catch (reason) { setError(`Ask Neo failed: ${String(reason)}`); }
    finally { setBusy(false); }
  }

  async function changeAcceptMode(next: AcceptMode) {
    const previous = acceptMode;
    setAcceptMode(next);
    setError('');
    try { setAcceptMode((await http.inbox.acceptMode.set({ mode: next })).mode); }
    catch (reason) { setAcceptMode(previous); setError(`Could not change accept mode (admins only): ${String(reason)}`); }
  }

  return <section className="inbox-page" aria-label="Inbox">
    <header className="page-header">
      <div><h1>Inbox</h1><p>Ask Neo to coordinate work across your agents.</p></div>
      <span className="connection" role="status">{connection}</span>
    </header>
    {notInstalled && <div data-testid="inbox-not-installed">
      <p className="page-error" role="status">The super agent is not installed yet. Install it here or from Extensions to use Ask Neo.</p>
      <EngineInstall engine="engine-superagent" testId="inbox-superagent-install" onReady={() => setRound((value) => value + 1)} />
    </div>}
    {!enabled && !notInstalled && <p className="page-error" role="status" data-testid="inbox-disabled">Superagent extension is disabled. Enable it on Extensions to use Ask Neo.</p>}
    {error && <p role="alert" className="page-error">{error}</p>}
    <form className="inbox-composer" onSubmit={(event) => { void ask(event); }}>
      <TextArea label="Ask Neo" id="inbox-prompt" rows={3} placeholder="What should Neo work on?" value={draft}
        onChange={setDraft} isDisabled={!enabled || busy} />
      <div className="inbox-controls">
        <Selector label="Agent" htmlName="inbox-agent" value={botId} onChange={setBotId}
          placeholder={!bots.length ? 'Create an agent first' : undefined}
          options={bots.length ? bots.map(bot => ({ value: bot.id, label: bot.name })) : [{ value: '', label: 'Create an agent first' }]} isDisabled={!enabled || busy} />
        <div className="inbox-mode-control">
          <SegmentedControl label="Mode" value={mode} onChange={value => setMode(value as 'observe' | 'act')} isDisabled={!enabled || busy}>
            <SegmentedControlItem label="Observe" value="observe" />
            <SegmentedControlItem label="Act" value="act" />
          </SegmentedControl>
          <p>{mode === 'observe' ? 'Suggest work for your review.' : 'Start work immediately, subject to approval policies.'}</p>
        </div>
      </div>
      <div className="inbox-notify">
        <Switch label="Notify on WhatsApp" value={notify} onChange={setNotify} isDisabled={!enabled || busy}
          ref={el => { if (el) el.dataset.testid = 'inbox-notify'; }} />
        {notify && <>
          <TextInput label="WhatsApp connection" value={notifyProfile} onChange={setNotifyProfile} isRequired isDisabled={!enabled || busy}
            ref={el => { if (el) { el.dataset.testid = 'inbox-notify-profile'; el.required = true; } }} />
          <TextInput label="Recipient number" value={notifyNumber} onChange={setNotifyNumber} placeholder="International digits" isRequired isDisabled={!enabled || busy}
            ref={el => { if (el) { el.dataset.testid = 'inbox-notify-number'; el.required = true; el.pattern = '[0-9]{6,20}'; } }} />
        </>}
      </div>
      <div className="inbox-controls">
        <Button type="submit" label={busy ? 'Sending…' : 'Ask Neo'} isDisabled={!enabled || !botId || !draft.trim() || busy} />
      </div>
    </form>
    {enabled && acceptMode && <div className="inbox-accept-mode">
      <Selector label="Accept mode for @neo comments and failing checks" htmlName="inbox-accept-mode" value={acceptMode}
        onChange={value => { void changeAcceptMode(value as AcceptMode); }} options={[
          { value: 'observe', label: 'Observe: suggest only' },
          { value: 'act-with-approval', label: 'Act with approval' },
          { value: 'act', label: 'Act' },
        ]} />
      <p>Only admins can change this policy. Destructive work still requires admin approval.</p>
    </div>}
    <div className="inbox-items" aria-label="Inbox items" ref={list} />
    {Object.values(controls).map(({ host, item }) => createPortal(
      <InboxControls key={`${item.id}:${item.status}`} item={item} onResult={renderItem} onError={setError} />, host, item.id))}
  </section>;
}
