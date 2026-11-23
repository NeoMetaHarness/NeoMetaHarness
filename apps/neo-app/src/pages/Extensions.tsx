import { useEffect, useRef, useState } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type ExtensionStatus, type GatewayEvent } from '@neometaharness/contracts';
import { Switch } from '@neometaharness/ui';
import { gatewayUrl, gatewayToken } from '../config';
import EngineInstall, { type InstallableEngine } from './EngineInstall';

/** Engines whose card offers Install (P7-16). */
const INSTALLABLE: readonly string[] = ['engine-hermes', 'engine-superagent'] satisfies InstallableEngine[];
const isInstallable = (id: string): id is InstallableEngine => INSTALLABLE.includes(id);

type Client = ContractRouterClient<typeof neoContract>;
const http = createORPCClient<Client>(new HttpLink({
  url: gatewayUrl(),
  headers: () => {
    const token = gatewayToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  },
}));

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function Extensions() {
  const [rows, setRows] = useState<ExtensionStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [connection, setConnection] = useState('Connecting');
  const [error, setError] = useState('');
  const latest = useRef(0);
  const [observed, setObserved] = useState<Record<string, number>>({});

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    void http.extensions.list().then((extensions) => {
      if (!disposed) {
        setRows(extensions);
        setLoading(false);
      }
    }).catch((reason: unknown) => {
      if (!disposed) {
        setLoading(false);
        setError(`Could not load extensions: ${String(reason)}`);
      }
    });

    const subscribe = async () => {
      let firstConnection = true;
      while (!disposed) {
        const token = gatewayToken();
        const wsUrl = gatewayUrl().replace(/^http/, 'ws') + '/ws';
        socket = token ? new WebSocket(wsUrl, ['bearer.' + token]) : new WebSocket(wsUrl);
        const stream = createORPCClient<Client>(new WebSocketLink({ websocket: socket }));
        try {
          await new Promise<void>((resolve, reject) => {
            socket!.addEventListener('open', () => resolve(), { once: true });
            socket!.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
          });
          if (disposed) break;
          setConnection('Live');
          if (!firstConnection) {
            // A gateway restart starts a new event sequence; load its current state before replay.
            latest.current = 0;
            setObserved({});
            const extensions = await http.extensions.list();
            if (!disposed) setRows(extensions);
          }
          firstConnection = false;
          for await (const event of await stream.events.subscribe({ since: latest.current })) {
            if (disposed) break;
            acceptEvent(event);
          }
        } catch (reason) {
          if (!disposed) setConnection(`Reconnecting: ${String(reason)}`);
        } finally {
          socket.close();
          if (!disposed) setConnection('Reconnecting');
        }
        if (!disposed) await wait(400);
      }
    };
    const acceptEvent = (event: GatewayEvent) => {
      if (event.seq <= latest.current) return;
      latest.current = event.seq;
      setConnection('Live');
      if (event.type !== 'extension.state') return;
      setObserved((previous) => ({ ...previous, [event.extensionId]: event.seq }));
      setRows((previous) => previous.map((row) => row.id === event.extensionId
        ? { ...row, status: event.status, desired: event.status !== 'disabled', health: event.status === 'disabled' ? undefined : row.health }
        : row));
      // The event carries status only. Refresh health after the event without polling.
      void http.extensions.list().then((extensions) => {
        if (!disposed && latest.current === event.seq) setRows(extensions);
      }).catch(() => { /* Reconnect will refresh from the gateway. */ });
    };
    void subscribe();
    return () => { disposed = true; socket?.close(); };
  }, []);

  const toggle = async (row: ExtensionStatus, enabled: boolean) => {
    setBusy(row.id);
    setError('');
    try {
      const result = enabled
        ? await http.extensions.enable({ id: row.id })
        : await http.extensions.disable({ id: row.id });
      // Status changes are sourced from the event subscription. The mutation carries health details.
      setRows((previous) => previous.map((item) => item.id === row.id ? { ...item, health: result.health } : item));
    } catch (reason) {
      setError(`Could not update ${row.id}: ${String(reason)}`);
    } finally {
      setBusy(null);
    }
  };

  return <section aria-label="Extensions" className="extensions-page">
    <header className="page-header">
      <div>
        <h1>Extensions</h1>
        <p>Enable the capabilities available in this Neo workspace.</p>
      </div>
      <span role="status" className="connection" aria-label="Gateway event connection">{connection}</span>
    </header>
    {error && <p role="alert" className="page-error">{error}</p>}
    {loading ? <p role="status">Loading extensions…</p> :
      <div className="extensions-list" aria-label="Installed extensions">
        {rows.map((row) => <article key={row.id} className="extension-row" data-testid={`extension-${row.id}`} data-event-seq={observed[row.id] ?? 0}>
          <div className="extension-details">
            <h2>{row.id}</h2>
            <p>{row.status === 'running' ? 'Running' : row.status === 'degraded' ? 'Needs attention' : 'Disabled'}
              {' · '}{row.health ? (row.health.ok ? 'Healthy' : 'Unhealthy') : 'Inactive'}</p>
            {row.reason && <p className="extension-reason">{row.reason}</p>}
            {isInstallable(row.id) && row.status !== 'disabled' && <EngineInstall
              key={row.id} engine={row.id} testId={`extension-${row.id}-install`}
              onReady={() => { void http.extensions.list().then(setRows).catch(() => { /* the event stream refreshes */ }); }} />}
          </div>
          <Switch label={`Enable ${row.id}`} value={row.desired} isLoading={busy === row.id}
            isDisabled={busy !== null} onChange={(enabled) => { void toggle(row, enabled); }} />
        </article>)}
      </div>}
  </section>;
}
