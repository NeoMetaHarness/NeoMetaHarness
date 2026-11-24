import { useEffect, useRef, useState } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type GatewayEvent } from '@neometaharness/contracts';
import { AlertDialog, Badge, Banner, Button, EmptyState, Heading, MoreMenu, Dialog, ResizeHandle, ScrollableArea, Section, SelectableCard, Selector, StatusDot, TextInput, useResizable } from '@neometaharness/ui';
import { gatewayUrl, gatewayToken } from '../config';
import './computers.css';
import VncAttach from './VncAttach';

type Client = ContractRouterClient<typeof neoContract>;
type Row = Awaited<ReturnType<Client['computers']['list']>>[number];
const http = createORPCClient<Client>(new HttpLink({
  url: gatewayUrl(),
  headers: () => {
    const token = gatewayToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  },
}));

export default function Computers() {
  const [computers, setComputers] = useState<Row[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [killEngaged, setKillEngaged] = useState(false);
  const [local, setLocal] = useState({ available: false, enabled: false });
  const [acting, setActing] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [hermesProfile, setHermesProfile] = useState('default');
  const [engine, setEngine] = useState<'hermes' | 'dsh'>('hermes');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [killPending, setKillPending] = useState(false);
  const [confirmation, setConfirmation] = useState<'resume' | 'share' | null>(null);
  const [attachOpen, setAttachOpen] = useState<'hermes' | 'vnc' | null>(null);
  const sidebar = useResizable({ defaultSize: 285, minSize: 235, maxSize: 420 });
  const frame = useRef<HTMLImageElement>(null);
  const active = useRef<string | null>(null);
  const lastSequence = useRef(0);
  const selectedRow = computers.find(({ id }) => id === selected);

  useEffect(() => { active.current = selected; }, [selected]);

  async function refresh() {
    const [rows, state, localStatus] = await Promise.all([http.computers.list(), http.computers.state(), http.computers.local.status()]);
    setComputers(rows);
    setKillEngaged(state.engaged);
    setLocal(localStatus);
    setSelected((previous) => rows.some(({ id }) => id === previous) ? previous : rows[0]?.id ?? null);
  }

  useEffect(() => {
    let closed = false;
    void refresh().catch((reason: unknown) => { if (!closed) setError(String(reason)); });
    const timer = window.setInterval(() => {
      void refresh().catch((reason: unknown) => { if (!closed) setError(String(reason)); });
    }, 2000);
    let socket: WebSocket | undefined;
    const subscribe = async () => {
      while (!closed) {
        const token = gatewayToken();
        socket = new WebSocket(gatewayUrl().replace(/^http/, 'ws') + '/ws', token ? ['bearer.' + token] : undefined);
        const client = createORPCClient<Client>(new WebSocketLink({ websocket: socket }));
        try {
          await new Promise<void>((resolve, reject) => {
            socket!.addEventListener('open', () => resolve(), { once: true });
            socket!.addEventListener('error', () => reject(new Error('Disconnected')), { once: true });
          });
          for await (const event of await client.events.subscribe({ since: lastSequence.current })) {
            if (closed) break;
            accept(event);
          }
        } catch {
          // Read-only polling continues while the event transport reconnects.
          lastSequence.current = 0;
          if (!closed) setActing(null);
        } finally {
          socket.close();
        }
        if (!closed) await new Promise((resolve) => setTimeout(resolve, 500));
      }
    };
    const accept = (event: GatewayEvent) => {
      if (event.seq <= lastSequence.current) return;
      lastSequence.current = event.seq;
      if (event.type === 'computer.acting' && event.computerId === active.current) {
        setActing(event.active ? `${event.engine} · ${event.action}` : null);
      }
      if (event.type === 'computer.kill') setKillEngaged(event.engaged);
      if (event.type === 'computer.lease') void refresh().catch(() => {});
    };
    void subscribe();
    return () => { closed = true; window.clearInterval(timer); socket?.close(); };
  }, []);

  useEffect(() => {
    if (!selected) {
      if (frame.current) frame.current.removeAttribute('src');
      return;
    }
    let closed = false;
    let fetching = false;
    const capture = async () => {
      if (fetching || closed) return;
      fetching = true;
      try {
        const shot = await http.computers.capture({ id: selected });
        if (!closed && frame.current) {
          frame.current.src = `data:image/png;base64,${shot.png}`;
          frame.current.width = shot.width;
          frame.current.height = shot.height;
        }
      } catch (reason) {
        if (!closed) setError(String(reason));
      } finally {
        fetching = false;
      }
    };
    void capture();
    const timer = window.setInterval(() => { void capture(); }, 500);
    return () => { closed = true; window.clearInterval(timer); };
  }, [selected]);

  async function perform(operation: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await operation();
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function setGlobalStop(engaged: boolean) {
    if (killPending) return;
    setKillPending(true);
    setError('');
    try {
      await http.computers.kill({ engaged });
      setKillEngaged(engaged);
      await refresh();
    } catch (reason) { setError(String(reason)); }
    finally { setKillPending(false); }
  }

  function shareDesktop() {
    void perform(async () => {
      if (!local.available) await http.extensions.enable({ id: 'computer-local' });
      await http.computers.local.set({ enabled: true });
      const added = await http.computers.attach({ providerId: 'computer-local', target: 'local-desktop' });
      setSelected(added.id);
    });
  }

  function attachChrome() {
    void perform(async () => {
      const available = await http.extensions.list();
      if (available.find(({ id }) => id === 'computer-headless-chrome')?.status !== 'running') {
        await http.extensions.enable({ id: 'computer-headless-chrome' });
      }
      const added = await http.computers.attach({ providerId: 'computer-headless-chrome', target: `chrome-${crypto.randomUUID()}` });
      setSelected(added.id);
    });
  }

  return <section className="computers-page" data-testid="computers-page" aria-label="Computers">
    <header className="page-header computers-header">
      <div><h1>Computers</h1><p>Private screens shared by assigned agents.</p></div>
      <Button label={killEngaged ? 'Resume agents' : 'Stop all agents'} data-testid="stop-all-agents"
        variant={killEngaged ? 'secondary' : 'destructive'} isDisabled={killPending}
        onClick={() => { if (killEngaged) setConfirmation('resume'); else void setGlobalStop(true); }}>
        {killEngaged ? 'Resume agents' : 'Stop all agents'}
      </Button>
    </header>
    {killEngaged && <Banner status="warning" title="Agents stopped globally" description="Screen viewing remains available." />}
    {error && <Banner status="error" title={error} />}
    <div className="computers-layout">
      <aside className="computers-sidebar" style={{ width: sidebar.size }}>
        <ScrollableArea label="Attached computers" height="100%" padding={2}>
        <Heading level={2}>Attached computers</Heading>
        <Section padding={2}>
          <Heading level={3}>Your desktop</Heading>
          <div data-testid="local-consent-status" role="status"><StatusDot variant={local.enabled ? 'success' : 'neutral'} label={local.enabled ? 'Sharing enabled' : 'Off'} /></div>
          <Button label={local.enabled ? 'Stop sharing my desktop' : 'Allow my desktop'} data-testid="local-consent" isDisabled={busy}
            variant={local.enabled ? 'destructive' : 'secondary'} onClick={() => {
              if (local.enabled) void perform(() => http.computers.local.set({ enabled: false }));
              else setConfirmation('share');
            }}>{local.enabled ? 'Stop sharing my desktop' : 'Allow my desktop'}</Button>
        </Section>
        <div className="computers-attach-actions">
          <Button label="Attach Chrome" data-testid="attach-chrome" isDisabled={busy} onClick={attachChrome}>Attach Chrome</Button>
          <MoreMenu label="Other attachment types" isDisabled={busy} items={[
            { label: 'Hermes bot screen', onClick: () => setAttachOpen('hermes') },
            { label: 'VNC screen', onClick: () => setAttachOpen('vnc') },
          ]} />
        </div>
        <Dialog aria-label={attachOpen === 'hermes' ? 'Attach Hermes bot screen' : 'Attach VNC screen'} isOpen={attachOpen !== null} onOpenChange={open => { if (!open) setAttachOpen(null); }}>
          <div className="computers-attach-dialog">
          <Heading level={2}>{attachOpen === 'hermes' ? 'Attach Hermes bot screen' : 'Attach VNC screen'}</Heading>
          {attachOpen === 'hermes' ?
        <form className="computers-vnc" aria-label="Attach Hermes bot screen" onSubmit={event => {
          event.preventDefault();
          const profile = hermesProfile.trim();
          if (!/^[a-z][a-z0-9_-]{0,47}$/.test(profile)) { setError('Invalid Hermes profile'); return; }
          void perform(async () => {
            const available = await http.extensions.list();
            if (available.find(({ id }) => id === 'computer-hermes-screen')?.status !== 'running') {
              await http.extensions.enable({ id: 'computer-hermes-screen' });
            }
            const added = await http.computers.attach({ providerId: 'computer-hermes-screen', target: `hermes-screen:${profile}` });
            setSelected(added.id);
            setAttachOpen(null);
          });
        }}>
          <TextInput label="Hermes bot profile" data-testid="hermes-screen-profile" value={hermesProfile}
            onChange={setHermesProfile} placeholder="default" isRequired />
          <Button type="submit" label="Attach Hermes bot screen" data-testid="attach-hermes-screen" isDisabled={busy || !hermesProfile.trim()}>
            Attach Hermes bot screen
          </Button>
        </form> : <VncAttach busy={busy} attach={target => void perform(async () => {
          const available = await http.extensions.list();
          if (available.find(({ id }) => id === 'computer-vnc')?.status !== 'running') {
            await http.extensions.enable({ id: 'computer-vnc' });
          }
          const added = await http.computers.attach({ providerId: 'computer-vnc', target });
          setSelected(added.id);
          setAttachOpen(null);
        })} />}
          <Button label="Cancel" variant="secondary" onClick={() => setAttachOpen(null)}>Cancel</Button>
          </div>
        </Dialog>
        <div className="computers-list" aria-label="Attached computers">
          {computers.map(computer => <SelectableCard key={computer.id} label={computer.id} data-testid={`computer-${computer.id}`}
            className="computer-row" isSelected={selected === computer.id} padding={2}
            onChange={() => { setSelected(computer.id); setActing(null); }}>
            <strong>{computer.id}</strong><span>{computer.providerId}</span>
            <Badge label={computer.holder === 'human' ? 'Human control' : 'Agent control'} variant={computer.holder === 'human' ? 'neutral' : 'success'} />
            <Badge label={`${computer.assignments.length} assigned`} />
          </SelectableCard>)}
          {computers.length === 0 && <EmptyState title="No computers attached" description="Attach a screen to share with agents." />}
        </div>
        </ScrollableArea>
      </aside>
      <div className="computers-resize"><ResizeHandle resizable={sidebar.props} direction="horizontal" hasDivider label="Resize computers list" /></div>
      <div className="computers-detail">
        {selectedRow ? <>
          <div className="computers-controlbar">
            <div><Heading level={2}>{selectedRow.id}</Heading>
              <div data-testid="computer-acting" role="status"><Badge label={acting ? `Agent acting · ${acting}` : selectedRow.holder === 'human' ? 'You have control' : 'Agent ready'} variant={acting ? 'warning' : 'neutral'} /></div></div>
            <div className="computers-actions">
              <Button label={selectedRow.holder === 'agent' ? 'Take over' : 'Hand back'} data-testid="computer-lease" isDisabled={busy} onClick={() => void perform(() =>
                http.computers.lease({ id: selectedRow.id, holder: selectedRow.holder === 'agent' ? 'human' : 'agent' }))}>
                {selectedRow.holder === 'agent' ? 'Take over' : 'Hand back'}
              </Button>
              <Button label="Release" data-testid="computer-release" isDisabled={busy} onClick={() => void perform(() =>
                http.computers.release({ id: selectedRow.id }))}>Release</Button>
            </div>
          </div>
          <div className="computer-viewer" aria-label="Live computer screen">
            <img data-testid="computer-frame" ref={frame} alt={`Live screen of ${selectedRow.id}`} />
          </div>
          <Section className="computers-assignments" aria-label="Assignments" padding={3}>
            <Heading level={3}>Assigned agents</Heading>
            {selectedRow.assignments.length ? <ul>{selectedRow.assignments.map(({ engine: name, targetId }) =>
              <li key={`${name}/${targetId}`}><Badge label={`${name} / ${targetId}`} /></li>)}</ul> : <p>No agents assigned.</p>}
            <form onSubmit={(event) => { event.preventDefault(); void perform(() =>
              http.computers.assign({ engine, targetId: target.trim(), computerId: selectedRow.id })); }}>
              <Selector label="Engine" value={engine} onChange={value => setEngine(value as typeof engine)} options={[{ value: 'hermes', label: 'Hermes bot' }, { value: 'dsh', label: 'DSH session' }]} isDisabled={busy} />
              <TextInput label="Bot or session ID" data-testid="computer-target" value={target} onChange={setTarget} placeholder="Name or session ID" isRequired isDisabled={busy} />
              <Button label="Assign" type="submit" isDisabled={busy || !target.trim()}>Assign</Button>
            </form>
          </Section>
        </> : <EmptyState title="Choose a computer" description="Attach an isolated Chrome screen to begin." actions={<Button label="Attach Chrome" isDisabled={busy} onClick={attachChrome}>Attach Chrome</Button>} />}
      </div>
    </div>
    <AlertDialog isOpen={confirmation !== null} onOpenChange={open => { if (!open) setConfirmation(null); }}
      title={confirmation === 'resume' ? 'Resume all agents?' : 'Share your desktop?'}
      description={confirmation === 'resume' ? 'Allow agents to resume computer operations globally.' : 'Enable local desktop sharing and attach this screen for assigned agents.'}
      actionLabel={confirmation === 'resume' ? 'Resume agents' : 'Allow sharing'}
      onAction={() => { const choice = confirmation; setConfirmation(null); if (choice === 'resume') void setGlobalStop(false); else if (choice === 'share') shareDesktop(); }} />
  </section>;
}
