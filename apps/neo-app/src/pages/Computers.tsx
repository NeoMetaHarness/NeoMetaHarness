import { useEffect, useRef, useState } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type GatewayEvent } from '@neometaharness/contracts';
import { Button } from '@neometaharness/ui';
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
  const [acting, setActing] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [engine, setEngine] = useState<'hermes' | 'dsh'>('hermes');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const frame = useRef<HTMLImageElement>(null);
  const active = useRef<string | null>(null);
  const lastSequence = useRef(0);
  const selectedRow = computers.find(({ id }) => id === selected);

  useEffect(() => { active.current = selected; }, [selected]);

  async function refresh() {
    const [rows, state] = await Promise.all([http.computers.list(), http.computers.state()]);
    setComputers(rows);
    setKillEngaged(state.engaged);
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

  return <section className="computers-page" data-testid="computers-page" aria-label="Computers">
    <header className="page-header computers-header">
      <div><h1>Computers</h1><p>Private screens shared by assigned agents.</p></div>
      <Button label={killEngaged ? 'Resume agents' : 'Stop all agents'} data-testid="stop-all-agents" onClick={() => void perform(() => http.computers.kill({ engaged: !killEngaged }))}
        isDisabled={busy}>{killEngaged ? 'Resume agents' : 'Stop all agents'}</Button>
    </header>
    {killEngaged && <p className="computers-stopped" role="status">Agents stopped globally. Screen viewing remains available.</p>}
    {error && <p role="alert" className="page-error">{error}</p>}
    <div className="computers-layout">
      <aside className="computers-sidebar">
        <h2>Attached computers</h2>
        <Button label="Attach Chrome" data-testid="attach-chrome" isDisabled={busy} onClick={() => void perform(async () => {
          const available = await http.extensions.list();
          if (available.find(({ id }) => id === 'computer-headless-chrome')?.status !== 'running') {
            await http.extensions.enable({ id: 'computer-headless-chrome' });
          }
          const added = await http.computers.attach({ providerId: 'computer-headless-chrome', target: `chrome-${crypto.randomUUID()}` });
          setSelected(added.id);
        })}>Attach Chrome</Button>
        <VncAttach busy={busy} attach={target => void perform(async () => {
          const available = await http.extensions.list();
          if (available.find(({ id }) => id === 'computer-vnc')?.status !== 'running') {
            await http.extensions.enable({ id: 'computer-vnc' });
          }
          const added = await http.computers.attach({ providerId: 'computer-vnc', target });
          setSelected(added.id);
        })} />
        <div className="computers-list" aria-label="Attached computers">
          {computers.map((computer) => <button type="button" key={computer.id} data-testid={`computer-${computer.id}`}
            className={selected === computer.id ? 'computer-row selected' : 'computer-row'}
            onClick={() => { setSelected(computer.id); setActing(null); }}>
            <strong>{computer.id}</strong><span>{computer.providerId}</span>
            <small>{computer.holder === 'human' ? 'Human control' : 'Agent control'}</small>
          </button>)}
          {computers.length === 0 && <p>No computers attached.</p>}
        </div>
      </aside>
      <div className="computers-detail">
        {selectedRow ? <>
          <div className="computers-controlbar">
            <div><h2>{selectedRow.id}</h2>
              <p data-testid="computer-acting" role="status">{acting ? `Agent acting · ${acting}` : selectedRow.holder === 'human' ? 'You have control' : 'Agent ready'}</p></div>
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
          <section className="computers-assignments" aria-label="Assignments">
            <h3>Assigned agents</h3>
            {selectedRow.assignments.length ? <ul>{selectedRow.assignments.map(({ engine: name, targetId }) =>
              <li key={`${name}/${targetId}`}>{name} · {targetId}</li>)}</ul> : <p>No agents assigned.</p>}
            <form onSubmit={(event) => { event.preventDefault(); void perform(() =>
              http.computers.assign({ engine, targetId: target.trim(), computerId: selectedRow.id })); }}>
              <label>Engine <select aria-label="Engine" value={engine} onChange={(event) => setEngine(event.target.value as 'hermes' | 'dsh')}>
                <option value="hermes">Hermes bot</option><option value="dsh">DSH session</option>
              </select></label>
              <label>Bot or session ID <input data-testid="computer-target" value={target} onChange={(event) => setTarget(event.target.value)}
                placeholder="Name or session ID" required /></label>
              <Button label="Assign" type="submit" isDisabled={busy || !target.trim()}>Assign</Button>
            </form>
          </section>
        </> : <div className="computers-empty"><h2>Choose a computer</h2><p>Attach an isolated Chrome screen to begin.</p></div>}
      </div>
    </div>
  </section>;
}
