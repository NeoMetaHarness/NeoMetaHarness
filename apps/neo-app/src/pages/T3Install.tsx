import { useEffect, useRef, useState } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type T3InstallStatus } from '@neometaharness/contracts';
import { Banner, Button, ProgressBar, Text } from '@neometaharness/ui';
import { gatewayToken, gatewayUrl } from '../config';

type Client = ContractRouterClient<typeof neoContract>;
const api = createORPCClient<Client>(new RPCLink({
  url: gatewayUrl(),
  headers: () => {
    const token = gatewayToken();
    return token ? { authorization: 'Bearer ' + token } : {};
  },
}));

/** Installed T3 needs its pinned server binary before the Coding page can connect. */
export default function T3Install({ onReady }: { onReady?: () => void }) {
  const [status, setStatus] = useState<T3InstallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [round, setRound] = useState(0);
  const reported = useRef('');
  const notify = useRef(onReady);
  notify.current = onReady;

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let failures = 0;
    const poll = async () => {
      let next: T3InstallStatus | undefined;
      try {
        next = await api.x['engine-t3'].install.status();
        if (disposed) return;
        if (failures >= 10) setError('');
        failures = 0;
        setStatus(next);
        const signature = `${next.state}|${next.message}|${next.error ?? ''}|${next.connected ?? false}`;
        if (signature !== reported.current) {
          reported.current = signature;
          notify.current?.(); // refresh the Extensions card's live health reason
        }
      } catch {
        failures++;
        if (failures === 10 && !disposed) setError('Could not read the T3 installation status. Try again from Extensions.');
      }
      if (!disposed) {
        const busy = next?.state === 'installing' || next?.phase === 'starting';
        timer = window.setTimeout(() => { void poll(); }, busy ? 1000 : 3000);
      }
    };
    void poll();
    return () => { disposed = true; if (timer) window.clearTimeout(timer); };
  }, [round]);

  const action = async (kind: 'install' | 'start') => {
    setBusy(true);
    setError('');
    try {
      const next = kind === 'install'
        ? await api.x['engine-t3'].install.start()
        : await api.x['engine-t3'].runtime.start();
      setStatus(next);
      if (next.connected) notify.current?.();
      setRound((old) => old + 1);
    } catch {
      setError('Could not ' + kind + ' T3. Check the Gateway status and try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!status && !error) return null;
  if (status?.connected && !error) return null;
  return <div className="hermes-install" data-testid="extension-engine-t3-install" data-state={status?.state ?? 'unknown'}>
    {status?.state === 'not_installed' && <>
      <Text as="p">Download the pinned T3 coding server.</Text>
      <Button label="Install T3" isDisabled={busy} onClick={() => { void action('install'); }}>Install T3</Button>
    </>}
    {status?.state === 'installing' && <ProgressBar label={status.message}
      {...(status.progress === undefined ? { isIndeterminate: true } : { value: Math.round(status.progress * 100), max: 100, hasValueLabel: true })} />}
    {status?.state === 'failed' && <Banner status="error" title="T3 installation failed"
      description={<Text as="p">{status.error ?? status.message}</Text>}
      endContent={<Button label="Retry T3 installation" isDisabled={busy} onClick={() => { void action('install'); }}>Try again</Button>} />}
    {status?.phase === 'starting' && <ProgressBar label={status.message} isIndeterminate />}
    {status?.state === 'ready' && status.phase !== 'starting' && <>
      <Button label={status.external ? 'Reconnect to T3' : 'Start T3'} isDisabled={busy || status.phase === 'starting'} onClick={() => { void action('start'); }}>
        {status.external ? 'Reconnect to T3' : 'Start T3'}
      </Button>
      {status.external && <Text as="p">Configure the server URL and scoped session in Settings to connect to an existing T3.</Text>}
    </>}
    {error && <Banner status="error" title="T3 is unavailable" description={<Text as="p">{error}</Text>}
      endContent={<Button label="Retry T3 status" isDisabled={busy} onClick={() => { setError(''); setRound((old) => old + 1); }}>Retry</Button>} />}
  </div>;
}
