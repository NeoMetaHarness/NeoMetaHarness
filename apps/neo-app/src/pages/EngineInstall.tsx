import { useEffect, useRef, useState } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type HermesInstallStatus } from '@neometaharness/contracts';
import { Banner, Button, ProgressBar, Text } from '@neometaharness/ui';
import { gatewayToken, gatewayUrl } from '../config';

type Client = ContractRouterClient<typeof neoContract>;
const api = createORPCClient<Client>(new RPCLink({
  url: gatewayUrl(),
  headers: () => {
    const token = gatewayToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  },
}));

/**
 * P7-16: install Hermes on demand. Used by the Extensions card and onboarding's bot step. Polls once a second only
 * while an install runs (and until the first answer); after the install the Gateway restarts engine-hermes, so its
 * routes are briefly absent and the panel keeps asking. If engine-hermes could not start (degraded), the panel shows
 * its reason with Try again instead of waiting forever.
 */
export default function HermesInstall({ onReady, testId = 'hermes-install' }: { onReady?: () => void; testId?: string }) {
  const [status, setStatus] = useState<HermesInstallStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [round, setRound] = useState(0);
  /** engine-hermes is degraded: its reason. The install routes are gone, so status calls fail. */
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const installing = useRef(false);
  const notified = useRef(false);
  const ready = useRef(onReady);
  ready.current = onReady;

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let loaded = false;
    let failures = 0;
    const poll = async () => {
      try {
        const next = await api.x['engine-hermes'].install.status();
        if (disposed) return;
        loaded = true; failures = 0;
        setStatus(next);
        installing.current = next.state === 'installing';
        if (next.state === 'ready' && !notified.current) { notified.current = true; ready.current?.(); }
      } catch {
        failures++; // engine-hermes is restarting after the install, or was only just enabled
        const row = await api.extensions.list().then((rows) => rows.find((item) => item.id === 'engine-hermes'), () => undefined);
        if (disposed) return;
        if (row?.status === 'degraded') {
          installing.current = false;
          setUnavailable(row.reason ?? 'Hermes could not start.');
          return;
        }
      }
      if (!disposed && (installing.current || !loaded) && failures < 300) {
        timer = window.setTimeout(() => { void poll(); }, 1000);
      }
    };
    void poll();
    return () => { disposed = true; if (timer) window.clearTimeout(timer); };
  }, [round]);

  const install = async () => {
    setStarting(true);
    try {
      const next = await api.x['engine-hermes'].install.start();
      installing.current = next.state === 'installing';
      setStatus(next);
      setRound((value) => value + 1);
    } catch (reason) {
      setStatus({ state: 'failed', message: 'Hermes could not be installed.', error: `Neo could not start the install: ${String(reason)}` });
    } finally {
      setStarting(false);
    }
  };

  const restart = async () => {
    setStarting(true);
    try {
      const row = await api.extensions.enable({ id: 'engine-hermes' });
      if (row.status === 'degraded') { setUnavailable(row.reason ?? 'Hermes could not start.'); return; }
      setUnavailable(null);
      setRound((value) => value + 1);
    } catch (reason) {
      setUnavailable(`Neo could not restart Hermes: ${String(reason)}`);
    } finally {
      setStarting(false);
    }
  };

  if (unavailable !== null) return <div className="hermes-install" data-testid={testId} data-state="unavailable">
    <div data-testid={`${testId}-error`}>
      <Banner status="error" title="Hermes could not start" description={<Text as="p">{unavailable}</Text>}
        endContent={<Button label="Try starting Hermes again" data-testid={`${testId}-retry`} isDisabled={starting} onClick={() => { void restart(); }}>Try again</Button>} />
    </div>
  </div>;
  if (!status || status.state === 'ready') return null;
  return <div className="hermes-install" data-testid={testId} data-state={status.state}>
    {status.state === 'not_installed' && <>
      <Text as="p">Hermes runs your bots and channels. It is not installed yet: Neo downloads it (about 100 MB) and sets it up.</Text>
      <Button label="Install Hermes" data-testid={`${testId}-start`} isDisabled={starting} onClick={() => { void install(); }}>Install Hermes</Button>
    </>}
    {status.state === 'installing' && <div data-testid={`${testId}-progress`}>
      <ProgressBar label={status.message}
        {...(status.progress === undefined ? { isIndeterminate: true } : { value: Math.round(status.progress * 100), max: 100, hasValueLabel: true })} />
    </div>}
    {status.state === 'failed' && <div data-testid={`${testId}-error`}>
      <Banner status="error" title="Hermes could not be installed" description={<Text as="p">{status.error ?? status.message}</Text>}
        endContent={<Button label="Try installing Hermes again" data-testid={`${testId}-retry`} isDisabled={starting} onClick={() => { void install(); }}>Try again</Button>} />
    </div>}
  </div>;
}
