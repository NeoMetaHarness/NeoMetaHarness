import { useEffect, useRef, useState } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type HermesInstallStatus, type SuperagentInstallStatus } from '@neometaharness/contracts';
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

type InstallStatus = HermesInstallStatus | SuperagentInstallStatus;
/** Engines that install on demand. Each has `x.<id>.install.status` and `x.<id>.install.start`. */
export type InstallableEngine = 'engine-hermes' | 'engine-superagent';

const ENGINES: Record<InstallableEngine, {
  /** As a sentence subject ("Hermes could not start") and inside a sentence ("Install Hermes"). */
  title: string; name: string; about: string;
  /** Another engine this one needs at run time; the panel says to install it first while it is not ready. */
  needs?: { engine: InstallableEngine; why: string };
}> = {
  'engine-hermes': {
    title: 'Hermes', name: 'Hermes',
    about: 'Hermes runs your bots and channels. It is not installed yet: Neo downloads it (about 100 MB) and sets it up.',
  },
  'engine-superagent': {
    title: 'The super agent', name: 'the super agent',
    about: 'The super agent turns requests in your Inbox into tickets for your bots. It is not installed yet: Neo downloads it (about 1 MB) and prepares it.',
    needs: { engine: 'engine-hermes', why: 'The super agent hands each ticket to one of your Hermes bots, so it needs Hermes to get work done.' },
  },
};

const installStatus = (engine: InstallableEngine): Promise<InstallStatus> => api.x[engine].install.status();
const installStart = (engine: InstallableEngine): Promise<InstallStatus> => api.x[engine].install.start();

/**
 * P7-16: install an engine on demand. Used by the Extensions card (Hermes, the super agent) and onboarding's bot
 * step (Hermes). Polls once a second only while an install runs (and until the first answer); after the install
 * the Gateway restarts the engine's extension, so its routes are briefly absent and the panel keeps asking. If the
 * extension could not start (degraded), the panel shows its reason with Try again instead of waiting forever.
 */
export default function EngineInstall({ engine = 'engine-hermes', onReady, testId = 'hermes-install' }: {
  engine?: InstallableEngine; onReady?: () => void; testId?: string;
}) {
  const copy = ENGINES[engine];
  const [status, setStatus] = useState<InstallStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [round, setRound] = useState(0);
  /** The extension is degraded: its reason. The install routes are gone, so status calls fail. */
  const [unavailable, setUnavailable] = useState<string | null>(null);
  /** The engine this one needs is not ready (false while unknown or when nothing is needed). */
  const [needsMissing, setNeedsMissing] = useState(false);
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
        const next = await installStatus(engine);
        if (disposed) return;
        loaded = true; failures = 0;
        setStatus(next);
        installing.current = next.state === 'installing';
        if (next.state === 'ready' && !notified.current) { notified.current = true; ready.current?.(); }
      } catch {
        failures++; // the extension is restarting after the install, or was only just enabled
        const row = await api.extensions.list().then((rows) => rows.find((item) => item.id === engine), () => undefined);
        if (disposed) return;
        if (row?.status === 'degraded') {
          installing.current = false;
          setUnavailable(row.reason ?? `${copy.title} could not start.`);
          return;
        }
      }
      if (!disposed && (installing.current || !loaded) && failures < 300) {
        timer = window.setTimeout(() => { void poll(); }, 1000);
      }
    };
    void poll();
    return () => { disposed = true; if (timer) window.clearTimeout(timer); };
  }, [round, engine, copy.title]);

  // The needed engine: disabled or not installed counts as missing. While it is missing, look again every few
  // seconds, so the note goes away once it is installed (from its own card or onboarding).
  const needs = copy.needs?.engine;
  const shown = status !== null && status.state !== 'ready';
  useEffect(() => {
    if (!needs || !shown) return;
    let disposed = false;
    let timer: number | undefined;
    const check = async () => {
      const missing = await installStatus(needs).then((next) => next.state !== 'ready', () => true);
      if (disposed) return;
      setNeedsMissing(missing);
      if (missing) timer = window.setTimeout(() => { void check(); }, 3000);
    };
    void check();
    return () => { disposed = true; if (timer) window.clearTimeout(timer); };
  }, [needs, shown, round]);

  const install = async () => {
    setStarting(true);
    try {
      const next = await installStart(engine);
      installing.current = next.state === 'installing';
      setStatus(next);
      setRound((value) => value + 1);
    } catch (reason) {
      setStatus({ state: 'failed', message: `${copy.title} could not be installed.`, error: `Neo could not start the install: ${String(reason)}` });
    } finally {
      setStarting(false);
    }
  };

  const restart = async () => {
    setStarting(true);
    try {
      const row = await api.extensions.enable({ id: engine });
      if (row.status === 'degraded') { setUnavailable(row.reason ?? `${copy.title} could not start.`); return; }
      setUnavailable(null);
      setRound((value) => value + 1);
    } catch (reason) {
      setUnavailable(`Neo could not restart ${copy.name}: ${String(reason)}`);
    } finally {
      setStarting(false);
    }
  };

  if (unavailable !== null) return <div className="hermes-install" data-testid={testId} data-state="unavailable">
    <div data-testid={`${testId}-error`}>
      <Banner status="error" title={`${copy.title} could not start`} description={<Text as="p">{unavailable}</Text>}
        endContent={<Button label={`Try starting ${copy.name} again`} data-testid={`${testId}-retry`} isDisabled={starting} onClick={() => { void restart(); }}>Try again</Button>} />
    </div>
  </div>;
  if (!status || status.state === 'ready') return null;
  const needed = copy.needs && needsMissing ? ENGINES[copy.needs.engine] : undefined;
  return <div className="hermes-install" data-testid={testId} data-state={status.state}>
    {needed && copy.needs && <div data-testid={`${testId}-needs`}>
      <Banner status="warning" title={`Install ${needed.name} first`} description={<Text as="p">{copy.needs.why}</Text>} />
    </div>}
    {status.state === 'not_installed' && <>
      <Text as="p">{copy.about}</Text>
      <Button label={`Install ${copy.name}`} data-testid={`${testId}-start`} isDisabled={starting} onClick={() => { void install(); }}>Install {copy.name}</Button>
    </>}
    {status.state === 'installing' && <div data-testid={`${testId}-progress`}>
      <ProgressBar label={status.message}
        {...(status.progress === undefined ? { isIndeterminate: true } : { value: Math.round(status.progress * 100), max: 100, hasValueLabel: true })} />
    </div>}
    {status.state === 'failed' && <div data-testid={`${testId}-error`}>
      <Banner status="error" title={`${copy.title} could not be installed`} description={<Text as="p">{status.error ?? status.message}</Text>}
        endContent={<Button label={`Try installing ${copy.name} again`} data-testid={`${testId}-retry`} isDisabled={starting} onClick={() => { void install(); }}>Try again</Button>} />
    </div>}
  </div>;
}
