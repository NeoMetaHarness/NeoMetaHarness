import { useEffect, useRef, useState } from 'react';
import type { ContractRouterClient } from '@orpc/contract';
import type { neoContract, ModelProviderRecord } from '@neometaharness/contracts';
import { Badge, Banner, Button, Card, Heading, Selector, Text } from '@neometaharness/ui';
import './subscription-options.css';

type Client = ContractRouterClient<typeof neoContract>;
type T3Provider = Awaited<ReturnType<Client['x']['engine-t3']['subscription']['status']>>['providers'][number];
type Flow = { id: string | null; url: string | null; code: string | null; interval: number; deadline: number };
type Outcome = 'pending' | 'approved' | 'cancelled' | 'error';
type Engine = 'hermes' | 't3';
type Subscription = Extract<ModelProviderRecord, { kind: 'subscription' }>;
export const localPresets = [
  { id: 'ollama', name: 'Ollama', url: 'http://127.0.0.1:11434/v1' },
  { id: 'lm-studio', name: 'LM Studio', url: 'http://127.0.0.1:1234/v1' },
] as const;

export function LocalPresets({ onSelect, disabled }: { onSelect: (preset: typeof localPresets[number]) => void; disabled?: boolean }) {
  return <div className="subscription-actions">
    <Text>Local AI</Text>
    {localPresets.map((preset) => <Button key={preset.id} label={preset.name} variant="secondary"
      data-testid={`local-preset-${preset.id}`} isDisabled={disabled} onClick={() => onSelect(preset)}>{preset.name}</Button>)}
  </div>;
}

export function SignIn({ api, engine, instanceId, signedIn, canStart, canLogout = false, onApproved, onRefresh, onLogout }: {
  api: Client; engine: Engine; instanceId: string; signedIn: boolean; canStart: boolean;
  onApproved: () => Promise<void>; onRefresh: () => void;
  canLogout?: boolean; onLogout?: () => Promise<void>;
}) {
  const [flow, setFlow] = useState<Flow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [approved, setApproved] = useState(false);
  const generation = useRef(0);
  const current = useRef<Flow | null>(null);
  const mounted = useRef(false);
  const approvedAction = useRef(onApproved);
  approvedAction.current = onApproved;
  const refreshAction = useRef(onRefresh);
  refreshAction.current = onRefresh;
  const prefix = `subscription-${engine}-${instanceId}`;
  const hermes = api.x['engine-hermes'].subscription;
  const t3 = api.x['engine-t3'].subscription;
  function update(next: Flow | null) { current.current = next; setFlow(next); }
  function fromT3(result: Awaited<ReturnType<typeof t3.start>>, previous?: Flow): Flow {
    return { id: result.flowId ?? previous?.id ?? null, url: result.verificationUrl ?? previous?.url ?? null,
      code: result.userCode ?? previous?.code ?? null, interval: 1500,
      deadline: result.expiresAt ? Date.parse(result.expiresAt) : previous?.deadline ?? Date.now() + 600_000 };
  }
  function outcome(phase: string): Outcome {
    if (['approved', 'succeeded'].includes(phase)) return 'approved';
    if (['pending', 'starting', 'waiting', 'verifying'].includes(phase)) return 'pending';
    return phase === 'cancelled' ? 'cancelled' : 'error';
  }
  async function cancelRemote(active: Flow) {
    if (!active.id) return 'cancelled';
    return engine === 'hermes'
      ? outcome((await hermes.cancel({ profile: instanceId, sessionId: active.id })).status)
      : outcome((await t3.cancel({ instanceId, flowId: active.id })).phase);
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      if (current.current) void cancelRemote(current.current).catch(() => {});
      current.current = null;
    };
  }, []);
  async function finish(result: Outcome, run: number) {
    if (!mounted.current || run !== generation.current) return;
    update(null);
    if (result === 'approved') {
      setApproved(true);
      try { await approvedAction.current(); }
      catch { if (mounted.current && run === generation.current) setError('Signed in, but the Model Hub could not save the provider. Retry to save it.'); }
      refreshAction.current();
    } else if (result === 'error') setError('Sign-in did not complete. Please retry.');
  }
  async function start() {
    const run = ++generation.current;
    setBusy(true);
    setError('');
    try {
      if (approved) { await approvedAction.current(); return; }
      if (current.current) await cancelRemote(current.current);
      update(null);
      if (engine === 'hermes') {
        const result = await hermes.start({ profile: instanceId });
        const next = { id: result.sessionId, url: result.verificationUrl, code: result.userCode,
          interval: Math.max(250, result.pollInterval * 1000), deadline: Date.now() + result.expiresIn * 1000 };
        if (!mounted.current || run !== generation.current) { void cancelRemote(next).catch(() => {}); return; }
        update(next);
      } else {
        const result = await t3.start({ instanceId });
        const next = fromT3(result);
        if (!mounted.current || run !== generation.current) { void cancelRemote(next).catch(() => {}); return; }
        if (outcome(result.phase) === 'pending') update(next);
        else await finish(outcome(result.phase), run);
      }
    } catch { if (mounted.current && run === generation.current) setError('Could not start or save sign-in. Please retry.'); }
    finally { if (mounted.current && run === generation.current) setBusy(false); }
  }
  useEffect(() => {
    if (!flow || busy || error) return;
    const run = generation.current;
    const timer = setTimeout(() => void (async () => {
      try {
        if (Date.now() >= flow.deadline) {
          await finish(await cancelRemote(flow), run);
          if (mounted.current && run === generation.current && !approved) setError('Sign-in expired. Please retry.');
          return;
        }
        const result = engine === 'hermes'
          ? await hermes.poll({ profile: instanceId, sessionId: flow.id! })
          : await t3.poll({ instanceId });
        if (!mounted.current || run !== generation.current) return;
        const state = outcome('status' in result ? result.status : result.phase);
        if (state === 'pending') update('phase' in result ? fromT3(result, flow) : { ...flow });
        else await finish(state, run);
      } catch { if (mounted.current && run === generation.current) setError('Could not check sign-in status. Retry or cancel.'); }
    })(), flow.interval);
    return () => clearTimeout(timer);
  }, [flow, busy, error]);
  async function cancel() {
    if (!current.current) return;
    const run = ++generation.current;
    setBusy(true);
    setError('');
    try { await finish(await cancelRemote(current.current), run); }
    catch { if (mounted.current && run === generation.current) setError('Could not cancel sign-in. Please retry.'); }
    finally { if (mounted.current && run === generation.current) setBusy(false); }
  }
  async function logout() {
    setBusy(true); setError('');
    try {
      if (engine === 'hermes') await hermes.logout({ profile: instanceId });
      else await t3.logout({ instanceId });
      setApproved(false);
      await onLogout?.();
    } catch { setError('Could not complete sign-out. Refresh status and retry.'); }
    finally { setBusy(false); refreshAction.current(); }
  }
  const connected = approved || signedIn;
  return <div className="subscription-row" data-testid={prefix}>
    <div className="subscription-actions">
      <Heading level={3}>{engine === 'hermes' ? 'Hermes' : `T3 · ${instanceId}`}</Heading>
      <Badge label={connected ? 'Signed in' : flow ? 'Waiting for approval' : 'Sign-in required'} variant={connected ? 'success' : flow ? 'warning' : 'neutral'} />
    </div>
    {flow && <div role="status" className="subscription-flow">
      <Text as="p">Complete authorization in your browser, then return here.</Text>
      {flow.url && <a href={flow.url} target="_blank" rel="noopener noreferrer">Open authorization page</a>}
      {flow.code && <Text as="p">Device code: <strong>{flow.code}</strong></Text>}
    </div>}
    {error && <Banner role="alert" status="error" title={error} />}
    <div className="subscription-actions">
      {(!connected || error) && (!flow || error) && <Button label={error ? 'Retry' : 'Sign in with ChatGPT / Codex'}
        data-testid={`${prefix}-start`} isDisabled={busy || !canStart} onClick={() => void start()}>
        {error ? 'Retry' : 'Sign in with ChatGPT / Codex'}</Button>}
      {flow && <Button label="Cancel sign-in" data-testid={`${prefix}-cancel`} variant="secondary" isDisabled={busy}
        onClick={() => void cancel()}>Cancel</Button>}
      {connected && <Button label="Use subscription" variant="secondary" isDisabled={busy}
        onClick={() => void approvedAction.current().catch(() => setError('Could not save the provider. Please retry.'))}>Use subscription</Button>}
    </div>
    {connected && (canLogout ? <Button label="Sign out" variant="secondary" data-testid={`${prefix}-logout`} isDisabled={busy} onClick={() => void logout()}>Sign out</Button>
      : <Text as="p">Sign out in {engine === 'hermes' ? 'Hermes' : 'T3'}.</Text>)}
  </div>;
}

export async function saveSubscription(api: Client, engine: Engine, profile?: string, signedIn = true) {
  const latest = await api.x.models.providers.list();
  const records = latest.filter((item): item is Subscription => item.kind === 'subscription' && item.vendor === 'openai');
  const existing = engine === 'hermes'
    ? records.find((item) => item.engines.hermes && (item.engines.hermes.profile ?? 'default') === profile)
      ?? (signedIn ? records.find((item) => !item.engines.hermes) : undefined)
    : records.find((item) => item.engines.t3) ?? (signedIn ? records[0] : undefined);
  if (!signedIn && !existing) return undefined;
  let id = existing?.id ?? 'chatgpt';
  for (let suffix = 2; !existing && latest.some((item) => item.id === id); suffix++) id = `chatgpt-${suffix}`;
  const status = signedIn ? 'signed-in' : 'signed-out';
  const engines: Subscription['engines'] = { ...existing?.engines, [engine]: engine === 'hermes' ? { status, profile } : { status } };
  return api.x.models.providers.put({ id, name: existing?.name ?? 'ChatGPT / Codex', kind: 'subscription', vendor: 'openai',
    status: Object.values(engines).some((entry) => ['signed-in', 'approved'].includes(entry.status)) ? 'signed-in' : 'signed-out', engines });
}

export function HermesProfileSignIn({ api, profile, onApproved, onLogout }: {
  api: Client; profile: string; onApproved: () => Promise<void>; onLogout?: () => Promise<void>;
}) {
  const [status, setStatus] = useState<{ signedIn: boolean | null; canLogout: boolean } | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api.x['engine-hermes'].subscription.status({ profile }, { signal: controller.signal }).then(setStatus)
      .catch(() => { if (!controller.signal.aborted) setStatus(null); });
    return () => controller.abort();
  }, [api, profile, refresh]);
  return <SignIn api={api} engine="hermes" instanceId={profile} canStart signedIn={status?.signedIn === true}
    canLogout={status?.canLogout === true && !!onLogout} onApproved={onApproved} onLogout={onLogout}
    onRefresh={() => setRefresh((value) => value + 1)} />;
}

export function SubscriptionOptions({ api, onSaved, deferHermes }: {
  api: Client; providers: ModelProviderRecord[]; onSaved: (provider: ModelProviderRecord) => void; deferHermes?: React.ReactNode;
}) {
  const [t3Providers, setT3Providers] = useState<T3Provider[]>([]);
  const [t3Unavailable, setT3Unavailable] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [profiles, setProfiles] = useState(['default']);
  const [profile, setProfile] = useState('default');
  useEffect(() => {
    if (deferHermes) return;
    const controller = new AbortController();
    void api.x['engine-hermes'].profiles.list(undefined, { signal: controller.signal }).then(({ profiles }) => {
      if (!controller.signal.aborted) setProfiles([...new Set(['default', ...profiles.map((item) => item.name)])]);
    }).catch(() => {});
    return () => controller.abort();
  }, [api, refresh, !!deferHermes]);
  useEffect(() => {
    const controller = new AbortController();
    void api.x['engine-t3'].subscription.status(undefined, { signal: controller.signal }).then(({ providers }) => {
      if (!controller.signal.aborted) { setT3Providers(providers); setT3Unavailable(false); }
    }).catch(() => { if (!controller.signal.aborted) { setT3Providers([]); setT3Unavailable(true); } });
    return () => controller.abort();
  }, [api, refresh]);
  async function save(engine: Engine, signedIn = true) {
    const saved = await saveSubscription(api, engine, engine === 'hermes' ? profile : undefined, signedIn);
    if (saved) onSaved(saved);
  }
  const refreshStatus = () => setRefresh((value) => value + 1);
  return <Card padding={4} className="subscription-options">
    <Heading level={2}>Subscription sign-in</Heading>
    <Text as="p">Use an existing ChatGPT subscription for supported engines.</Text>
    {deferHermes ?? <>
      <Selector label="Hermes profile" data-testid="subscription-hermes-profile" value={profile} onChange={setProfile}
        options={profiles.map((name) => ({ value: name, label: name }))} />
      <HermesProfileSignIn key={`${profile}-${refresh}`} api={api} profile={profile}
        onApproved={() => save('hermes')} onLogout={() => save('hermes', false)} />
    </>}
    {t3Providers.filter((provider) => provider.provider === 'codex').map((provider) => <SignIn key={provider.instanceId}
      api={api} engine="t3" instanceId={provider.instanceId} canStart={provider.canStart} signedIn={provider.signedIn}
      canLogout={provider.canLogout} onApproved={() => save('t3')} onRefresh={refreshStatus}
      onLogout={async () => {
        const status = await api.x['engine-t3'].subscription.status();
        await save('t3', status.providers.some((item) => item.provider === 'codex' && item.signedIn));
      }} />)}
    {!t3Providers.some((provider) => provider.provider === 'codex') && <Text as="p">T3: {t3Unavailable ? 'Status unavailable. Start T3 and refresh.' : 'No Codex provider detected.'}</Text>}
    <Heading level={3}>Claude</Heading>
    {t3Providers.filter((provider) => provider.provider === 'claude').map((provider) => <div key={provider.instanceId} className="subscription-row">
      {provider.status !== 'unknown' && <Badge label={provider.signedIn ? 'Claude sign-in detected' : 'Claude sign-in not detected'} variant={provider.signedIn ? 'success' : 'neutral'} />}
      <Text as="p">T3 · {provider.instanceId}: {provider.guidance}</Text>
    </div>)}
    {!t3Providers.some((provider) => provider.provider === 'claude') && <Text as="p">T3: Claude status unavailable. Sign in with <code>claude auth login</code> in T3's isolated environment, then refresh.</Text>}
    <Text as="p">Hermes: Sign in to Claude using Hermes' own CLI.</Text>
    <Button label="Refresh subscription status" variant="secondary" onClick={refreshStatus}>Refresh status</Button>
  </Card>;
}
