import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type AcceptMode, type InboxItem } from '@neometaharness/contracts';
import { Button } from '@neometaharness/ui';
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
    if (new URLSearchParams(window.location.search).get('openInbox') === item.id) {
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
    if (item.status === 'suggestion') {
      // Suggestions: proposed work a member accepts (policy-checked by the gateway) or dismisses.
      const actions = document.createElement('div');
      actions.className = 'inbox-suggestion';
      actions.dataset.testid = 'inbox-suggestion';
      const upstream = item.source === 'neo/upstream';
      if (upstream) {
        actions.append(textNode('p', item.botId === 'neo-system'
          ? 'Configure a bot for upstream work to approve this bump'
          : 'Upgrade: an admin must approve; the bot bumps on a branch and reports', 'inbox-blocked'));
      } else if (item.destructive) actions.append(textNode('p', 'Destructive: an admin must accept', 'inbox-blocked'));
      const buttons: HTMLButtonElement[] = [];
      const run = async (label: string, call: () => Promise<InboxItem>) => {
        for (const control of buttons) control.disabled = true;
        setError('');
        try { renderItem(await call()); }
        catch (reason) {
          setError(`Could not ${label} suggestion: ${String(reason)}`);
          for (const control of buttons) control.disabled = false;
        }
      };
      // An upstream bump can be approved only once a bot is assigned to do it.
      if (!upstream || item.botId !== 'neo-system') {
        const accept = textNode('button', upstream ? 'Approve bump' : 'Accept', 'inbox-accept') as HTMLButtonElement;
        accept.type = 'button';
        accept.dataset.action = 'accept';
        accept.onclick = () => run('accept', () => http.inbox.accept({ id: item.id }));
        buttons.push(accept);
      }
      const dismiss = textNode('button', 'Dismiss', 'inbox-accept') as HTMLButtonElement;
      dismiss.type = 'button';
      dismiss.dataset.action = 'dismiss';
      dismiss.onclick = () => run('dismiss', () => http.inbox.dismiss({ id: item.id }));
      buttons.push(dismiss);
      actions.append(...buttons);
      content.push(actions);
    }
    if (item.status === 'question') {
      const form = document.createElement('form');
      form.className = 'inbox-response';
      form.dataset.testid = 'inbox-question';
      const label = textNode('label', item.report?.question || item.report?.summary || 'Your answer');
      const answer = document.createElement('textarea');
      answer.name = 'answer';
      answer.required = true;
      answer.setAttribute('aria-label', 'Answer question');
      const submit = textNode('button', 'Reply', 'inbox-accept') as HTMLButtonElement;
      submit.type = 'submit';
      submit.dataset.action = 'reply';
      label.append(answer);
      form.append(label, submit);
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (!answer.value.trim()) return;
        submit.disabled = true;
        setError('');
        try { renderItem(await http.inbox.reply({ id: item.id, answer: answer.value.trim() })); }
        catch (reason) { setError(`Could not reply: ${String(reason)}`); submit.disabled = false; }
      };
      content.push(form);
    }
    if (item.status === 'approval') {
      const form = document.createElement('form');
      form.className = 'inbox-response';
      form.dataset.testid = 'inbox-approval';
      form.append(textNode('p', item.approval?.reason || 'Approval requested'));
      if (item.approval?.destructive) form.append(textNode('p', 'Admin approval required'));
      const label = textNode('label', 'Reason');
      const reason = document.createElement('textarea');
      reason.name = 'reason';
      reason.required = true;
      reason.setAttribute('aria-label', 'Approval reason');
      label.append(reason);
      form.append(label);
      for (const decision of ['approve', 'deny'] as const) {
        const button = textNode('button', decision === 'approve' ? 'Approve' : 'Deny', 'inbox-accept') as HTMLButtonElement;
        button.type = 'button';
        button.dataset.action = decision;
        button.onclick = async () => {
          if (!reason.value.trim()) { reason.reportValidity(); return; }
          for (const control of form.querySelectorAll('button')) control.disabled = true;
          setError('');
          try { renderItem(await http.inbox.approval.decide({ id: item.id, decision, reason: reason.value.trim() })); }
          catch (error) {
            setError(`Could not ${decision}: ${String(error)}`);
            for (const control of form.querySelectorAll('button')) control.disabled = false;
          }
        };
        form.append(button);
      }
      content.push(form);
    }
    if (item.status === 'failed') {
      const retry = textNode('button', 'Retry', 'inbox-accept') as HTMLButtonElement;
      retry.type = 'button';
      retry.dataset.action = 'retry';
      retry.onclick = async () => {
        retry.disabled = true;
        setError('');
        try { renderItem(await http.inbox.retry({ id: item.id })); }
        catch (error) { setError(`Could not retry: ${String(error)}`); retry.disabled = false; }
      };
      content.push(retry);
    }
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
    row.replaceChildren(...content);
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
      rows.current.clear();
      list.current.replaceChildren();
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
    return () => { closed = true; active.current = false; socket?.close(); rows.current.clear(); };
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
      <label htmlFor="inbox-prompt">Ask Neo</label>
      <textarea id="inbox-prompt" rows={3} placeholder="What should Neo work on?" value={draft}
        onChange={(event) => setDraft(event.target.value)} disabled={!enabled || busy} />
      <fieldset><legend>Completion notification</legend>
        <label><input data-testid="inbox-notify" type="checkbox" checked={notify} onChange={event => setNotify(event.target.checked)} disabled={!enabled || busy} />Notify on WhatsApp</label>
        {notify && <>
          <label>WhatsApp connection <input data-testid="inbox-notify-profile" value={notifyProfile} onChange={event => setNotifyProfile(event.target.value)} required disabled={!enabled || busy} /></label>
          <label>Recipient number <input data-testid="inbox-notify-number" value={notifyNumber} onChange={event => setNotifyNumber(event.target.value)} placeholder="International digits" pattern="[0-9]{6,20}" required disabled={!enabled || busy} /></label>
        </>}
      </fieldset>
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
    {enabled && acceptMode && <label className="inbox-accept-mode">
      Accept mode for @neo comments and failing checks{' '}
      <select aria-label="Accept mode" value={acceptMode} onChange={(event) => { void changeAcceptMode(event.target.value as AcceptMode); }}>
        <option value="observe">Observe: suggest only</option>
        <option value="act-with-approval">Act with approval</option>
        <option value="act">Act</option>
      </select>
    </label>}
    <div className="inbox-items" aria-label="Inbox items" ref={list} />
  </section>;
}
