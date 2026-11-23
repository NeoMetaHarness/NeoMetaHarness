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

type NeedsNote = { title: string; detail: string };

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
  /** What the engine this one needs is missing (null while unknown, when it is ready or nothing is needed). */
  const [needsMissing, setNeedsMissing] = useState<NeedsNote | null>(null);
  const needsNote = useRef<NeedsNote | null>(null);
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

  // The needed engine, from its Extensions row: turned off, needing attention (its reason) or not installed. While
  // it is not ready, look again every few seconds, so the note follows it (its own card, onboarding, a restart).
  const needs = copy.needs?.engine;
  const shown = status !== null && status.state !== 'ready';
  useEffect(() => {
    if (!needs || !shown) return;
    const other = ENGINES[needs];
    let disposed = false;
    let timer: number | undefined;
    const check = async () => {
      const rows = await api.extensions.list().catch(() => undefined);
      if (disposed) return;
      if (!rows) { timer = window.setTimeout(() => { void check(); }, 3000); return; } // Gateway unreachable: keep the note
      const row = rows.find((item) => item.id === needs);
      let note: NeedsNote | null = null;
      if (!row || row.status === 'disabled') note = { title: `Turn on ${other.name} in Extensions`, detail: copy.needs!.why };
      else if (row.status === 'degraded') note = { title: `${other.title} needs attention`, detail: row.reason ?? `${other.title} could not start.` };
      else {
        // Running: installed, or in install mode. No answer means it is restarting; that is not worth a note.
        const state = await installStatus(needs).then((next) => next.state, () => undefined);
        if (state && state !== 'ready') note = { title: `Install ${other.name} first`, detail: copy.needs!.why };
        if (!state) note = needsNote.current;
      }
      if (disposed) return;
      needsNote.current = note;
      setNeedsMissing(note);
      if (note || !row || row.status !== 'running') timer = window.setTimeout(() => { void check(); }, 3000);
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
  return <div className="hermes-install" data-testid={testId} data-state={status.state}>
    {needsMissing && <div data-testid={`${testId}-needs`}>
      <Banner status="warning" title={needsMissing.title} description={<Text as="p">{needsMissing.detail}</Text>} />
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
