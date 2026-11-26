import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createORPCClient, ORPCError } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type ModelProviderRecord } from '@neometaharness/contracts';
import { Banner, Button, Card, ChatMessageBubble, Heading, Skeleton, Spinner, StatusDot, Step, Stepper, Text, TextArea, TextInput, Timer } from '@neometaharness/ui';
import { gatewayToken, gatewayUrl } from '../config';
import HermesInstall from './EngineInstall';
import { HermesProfileSignIn, LocalPresets, saveSubscription, SubscriptionOptions } from './SubscriptionOptions';
import './onboarding.css';

type Client = ContractRouterClient<typeof neoContract>;
const api = createORPCClient<Client>(new RPCLink({
  url: gatewayUrl(),
  headers: () => {
    const token = gatewayToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  },
}));

type Stage = 'owner' | 'model' | 'bot' | 'channel' | 'chat';
const stages: Stage[] = ['owner', 'model', 'bot', 'channel', 'chat'];
const labels: Record<Stage, string> = {
  owner: 'Workspace & owner', model: 'Model', bot: 'Bot', channel: 'Channel', chat: 'First reply',
};
type Checkpoint = { stage: Stage; bot: string; subscriptionModel?: string };
const replies = new Map<string, { message: string; reply: string; modelKey: string; bot: string }>();
const HERMES_CHECK_TIMEOUT = 60_000;

function modelKey(selection: { providerId: string; model: string } | null | undefined) {
  return selection ? JSON.stringify([selection.providerId, selection.model]) : '';
}

async function checkHermes(signal: AbortSignal) {
  // The install route is published by the active extension. Avoid restarting or
  // synchronizing agents when it is already available.
  try {
    return await api.x['engine-hermes'].install.status(undefined, { signal });
  } catch (reason) {
    if (!(reason instanceof ORPCError) || reason.code !== 'NOT_FOUND') throw reason;
  }
  const enabled = await api.extensions.enable({ id: 'engine-hermes' }, { signal });
  if (enabled.status !== 'running') throw new Error(enabled.reason || 'Hermes engine unavailable');
  return api.x['engine-hermes'].install.status(undefined, { signal });
}

function hermesFailure(reason: unknown, deadline: AbortSignal) {
  return deadline.aborted
    ? 'Hermes did not respond within 60 seconds. Retry the readiness check.'
    : `Cannot check Hermes: ${String(reason)}. Retry the readiness check.`;
}

function readCheckpoint(key: string): Checkpoint | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (value && stages.includes(value.stage) && typeof value.bot === 'string') return value;
  } catch { /* Session storage may be unavailable. */ }
}

function writeCheckpoint(key: string, checkpoint: Checkpoint) {
  try { sessionStorage.setItem(key, JSON.stringify(checkpoint)); } catch { /* Navigation still works. */ }
}

function SetupTiming({ startedAt, stepStartedAt }: { startedAt: number; stepStartedAt: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);
  const formatTime = (start: number) => {
    const seconds = Math.max(0, Math.floor((now - start) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  return <div className="neo-onboarding-status" role="status" aria-live="off">
    <Text data-testid="onboarding-step-timer">This step {formatTime(stepStartedAt)}</Text>
    <Text data-testid="onboarding-total-timer">Total {formatTime(startedAt)}</Text>
  </div>;
}

export default function Onboarding({ onOpen, onSkip, onCompleted, onIncomplete }: {
  onOpen: (path: string) => void;
  onSkip: () => void;
  onCompleted: () => void;
  onIncomplete: (incomplete: boolean) => void;
}) {
  const [stage, setStage] = useState<Stage>('owner');
  const [owner, setOwner] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [providers, setProviders] = useState<ModelProviderRecord[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [model, setModel] = useState('gpt-4.1-mini');
  const [subscriptionModel, setSubscriptionModel] = useState('');
  const [codexModel, setCodexModel] = useState('gpt-5');
  const [configuredModel, setConfiguredModel] = useState(false);
  const [addProvider, setAddProvider] = useState(false);
  const [providerId, setProviderId] = useState('my-provider');
  const [providerName, setProviderName] = useState('OpenAI-compatible');
  const [providerUrl, setProviderUrl] = useState('https://api.openai.com/v1');
  const [providerKey, setProviderKey] = useState('');
  const [botName, setBotName] = useState('first-bot');
  const [createdBot, setCreatedBot] = useState('');
  const [hermes, setHermes] = useState<'checking' | 'missing' | 'failed' | 'ready'>('checking');
  const [message, setMessage] = useState('Hi! Please introduce yourself in one sentence.');
  const [reply, setReply] = useState('');
  const [chatReady, setChatReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [hermesError, setHermesError] = useState('');
  const checkpointKey = useRef('');
  const cardRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const startedAt = useRef(Date.now());
  const [stepStartedAt, setStepStartedAt] = useState(Date.now);
  const lifetime = useRef(new AbortController());
  const subscriptionSave = useRef<AbortController | null>(null);
  const subscriptionGeneration = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      socketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    const signal = controller.signal;
    setLoading(true);
    setLoadError('');
    void (async () => {
      const status = await api.onboarding.get(undefined, { signal });
      if (!mounted) return;
      onIncomplete(!status.completed);
      const enabled = await api.extensions.enable({ id: 'models' }, { signal });
      if (enabled.status !== 'running') throw new Error(enabled.reason || 'Model Hub is unavailable');
      const [available, roles] = await Promise.all([api.x.models.providers.list(undefined, { signal }), api.x.models.roles.get(undefined, { signal })]);
      if (!mounted) return;
      const key = JSON.stringify(['neo-onboarding-v1', gatewayUrl(), status.workspaceName, status.ownerName]);
      const checkpoint = status.completed ? undefined : readCheckpoint(key);
      let next = checkpoint?.stage ?? 'owner';
      let bot = checkpoint?.bot ?? '';
      const deferred = typeof checkpoint?.subscriptionModel === 'string' ? checkpoint.subscriptionModel : '';
      let effectiveModel = roles.default;
      let readiness: typeof hermes = 'checking';
      let readinessError = '';
      // Validate saved steps against the current Gateway evidence.
      if (stages.indexOf(next) >= stages.indexOf('bot') && !roles.default && !deferred) {
        next = 'model';
        bot = '';
      }
      if (next === 'channel' || next === 'chat' || (next === 'bot' && deferred && bot)) {
        const deadline = AbortSignal.timeout(HERMES_CHECK_TIMEOUT);
        const validationSignal = AbortSignal.any([signal, deadline]);
        try {
          const install = await checkHermes(validationSignal);
          readiness = install.state === 'ready' ? 'ready' : 'missing';
          if (readiness !== 'ready') {
            next = 'bot';
            bot = '';
          } else {
            const existing = await api.x['engine-hermes'].profiles.list(undefined, { signal: validationSignal });
            if (!existing.profiles.some((profile) => profile.name === bot)) {
              next = 'bot';
              bot = '';
            } else if (deferred && next !== 'bot') {
              const { selection } = await api.x.models.override.get({ profile: bot }, { signal: validationSignal });
              const provider = available.find((item) => item.id === selection?.providerId);
              const native = await api.x['engine-hermes'].subscription.status({ profile: bot }, { signal: validationSignal });
              if (!selection || selection.model !== deferred || provider?.kind !== 'subscription' || provider.engines.hermes?.profile !== bot
                || !['signed-in', 'approved'].includes(provider.engines.hermes.status) || native.signedIn !== true) next = 'bot';
              else effectiveModel = selection;
            }
          }
        } catch (reason) {
          next = 'bot';
          bot = '';
          readiness = 'failed';
          readinessError = hermesFailure(reason, deadline);
        }
      }
      if (!mounted) return;
      checkpointKey.current = key;
      setOwner(status.ownerName);
      setWorkspace(status.workspaceName);
      setProviders(available);
      const apiProviders = available.filter((provider) => provider.kind === 'openai-compatible');
      const apiDefault = apiProviders.some((provider) => provider.id === roles.default?.providerId) ? roles.default : undefined;
      setSelectedProvider(apiDefault?.providerId ?? apiProviders[0]?.id ?? '');
      setModel(roles.default?.model ?? 'gpt-4.1-mini');
      setConfiguredModel(!!apiDefault);
      setAddProvider(apiProviders.length === 0);
      setStage(next);
      setCreatedBot(bot);
      setSubscriptionModel(deferred);
      if (deferred) setCodexModel(deferred);
      if (checkpoint?.bot) setBotName(checkpoint.bot);
      setHermes(readiness);
      setHermesError(readinessError);
      const previousReply = next === 'chat' ? replies.get(key) : undefined;
      setReply('');
      setChatReady(false);
      if (previousReply && previousReply.modelKey === modelKey(effectiveModel) && previousReply.bot === bot) {
        setMessage(previousReply.message);
        setReply(previousReply.reply);
        setChatReady(true);
      } else {
        replies.delete(key);
      }
      writeCheckpoint(key, { stage: next, bot, subscriptionModel: deferred });
    })().catch((reason) => {
      if (mounted) setLoadError(String(reason));
    }).finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; controller.abort(); };
  }, [loadAttempt, onIncomplete]);

  useEffect(() => {
    if (!loading && !loadError) {
      const heading = cardRef.current?.querySelector<HTMLElement>('h2');
      if (heading) { heading.tabIndex = -1; heading.focus(); }
    }
  }, [stage, loading, loadError]);

  function advance(next: Stage, bot = createdBot, deferred = subscriptionModel) {
    subscriptionGeneration.current++;
    subscriptionSave.current?.abort();
    subscriptionSave.current = null;
    setStepStartedAt(Date.now());
    setError('');
    if (next === 'bot' || next === 'model' || next === 'owner') {
      replies.delete(checkpointKey.current);
      setChatReady(false);
      setReply('');
    }
    if (next === 'bot') setHermes('checking');
    writeCheckpoint(checkpointKey.current, { stage: next, bot, subscriptionModel: deferred });
    setStage(next);
  }

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const saved = await api.x.models.providers.put({ id: providerId.trim(), name: providerName.trim(),
        kind: 'openai-compatible', baseUrl: providerUrl.trim(), ...(providerKey ? { apiKey: providerKey } : {}) });
      setProviders((previous) => [...previous.filter((item) => item.id !== saved.id), saved]);
      setSelectedProvider(saved.id);
      setProviderKey('');
      setAddProvider(false);
    } catch (reason) { setError(`Cannot save provider: ${String(reason)}`); }
    finally { setBusy(false); }
  }

  async function saveModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!providers.some((provider) => provider.id === selectedProvider && provider.kind === 'openai-compatible') || !model.trim() || busy) return;
    const signal = lifetime.current.signal;
    setBusy(true);
    setError('');
    try {
      await api.x.models.roles.set({ role: 'default', providerId: selectedProvider, model: model.trim() }, { signal });
      if (signal.aborted) return;
      setConfiguredModel(true);
      setSubscriptionModel('');
      setCreatedBot('');
      advance('bot', '', '');
    } catch (reason) { if (!signal.aborted) setError(`Cannot save model: ${String(reason)}`); }
    finally { if (!signal.aborted) setBusy(false); }
  }

  // P7-16: installed apps ship without Hermes. The bot step offers the install instead of an error.
  useEffect(() => {
    if (stage !== 'bot' || loading || loadError || hermes !== 'checking') return;
    let mounted = true;
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(HERMES_CHECK_TIMEOUT);
    const signal = AbortSignal.any([controller.signal, deadline]);
    setHermesError('');
    void checkHermes(signal)
      .then((install) => {
        if (mounted) setHermes(install.state === 'ready' ? 'ready' : 'missing');
      })
      .catch((reason) => { if (mounted) { setHermes('failed'); setHermesError(hermesFailure(reason, deadline)); } });
    return () => { mounted = false; controller.abort(); };
  }, [stage, hermes, loading, loadError]);

  async function createBot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!botName.trim() || busy || hermes !== 'ready') return;
    const signal = lifetime.current.signal;
    setBusy(true);
    setError('');
    try {
      const install = await checkHermes(AbortSignal.any([signal, AbortSignal.timeout(HERMES_CHECK_TIMEOUT)]));
      if (signal.aborted) return;
      if (install.state !== 'ready') {
        setHermes('missing');
        setError('Hermes is not installed yet. Install it above, then create your bot.');
        return;
      }
      setHermes('ready');
      const existing = await api.x['engine-hermes'].profiles.list(undefined, { signal });
      if (signal.aborted) return;
      const created = existing.profiles.find((profile) => profile.name === botName.trim())
        ?? await api.x['engine-hermes'].profiles.create({ name: botName.trim() }, { signal });
      if (signal.aborted) return;
      setCreatedBot(created.name);
      if (subscriptionModel) writeCheckpoint(checkpointKey.current, { stage: 'bot', bot: created.name, subscriptionModel });
      else advance('channel', created.name);
    } catch (reason) { if (!signal.aborted) { setError(`Cannot create bot: ${String(reason)}`); setHermes('checking'); } }
    finally { if (!signal.aborted) setBusy(false); }
  }

  async function completeSubscription() {
    subscriptionSave.current?.abort();
    const controller = new AbortController();
    subscriptionSave.current = controller;
    const generation = ++subscriptionGeneration.current;
    const signal = AbortSignal.any([lifetime.current.signal, controller.signal]);
    try {
      const saved = await saveSubscription(api, 'hermes', createdBot, true, signal);
      if (signal.aborted || generation !== subscriptionGeneration.current) return;
      if (!saved) throw new Error('Could not save subscription');
      await api.x.models.override.set({ profile: createdBot, providerId: saved.id, model: subscriptionModel }, { signal });
      if (signal.aborted || generation !== subscriptionGeneration.current) return;
      setProviders((previous) => [...previous.filter((item) => item.id !== saved.id), saved]);
      advance('channel', createdBot);
    } finally {
      if (subscriptionSave.current === controller) subscriptionSave.current = null;
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!createdBot || !message.trim() || busy) return;
    const signal = lifetime.current.signal;
    setBusy(true);
    setChatReady(false);
    replies.delete(checkpointKey.current);
    setReply('');
    setError('');
    let text = '';
    let socket: WebSocket | undefined;
    try {
      const selection = modelKey(subscriptionModel
        ? (await api.x.models.override.get({ profile: createdBot }, { signal })).selection
        : (await api.x.models.roles.get(undefined, { signal })).default);
      if (signal.aborted) return;
      const started = await api.x['engine-hermes'].runs.start({ profile: createdBot, input: message.trim() }, { signal });
      if (signal.aborted) return;
      const token = gatewayToken();
      const url = gatewayUrl().replace(/^http/, 'ws') + '/ws';
      socket = token ? new WebSocket(url, ['bearer.' + token]) : new WebSocket(url);
      socketRef.current = socket;
      const stream = createORPCClient<Client>(new WebSocketLink({ websocket: socket }));
      let completed = false;
      for await (const event of await stream.x['engine-hermes'].runs.events({ profile: createdBot, runId: started.run_id }, { signal })) {
        if (signal.aborted) return;
        if (event.kind === 'text.delta') {
          text += event.textDelta ?? '';
          setReply(text);
        }
        if (event.type === 'run.failed' || event.type === 'run.cancelled' || event.type === 'run.interrupted') {
          throw new Error(`Bot run ${event.type}`);
        }
        if (event.type === 'run.completed') { completed = true; break; }
      }
      if (signal.aborted) return;
      if (!completed || !text.trim()) throw new Error('Bot did not finish with a reply. Try again.');
      replies.set(checkpointKey.current, { message, reply: text, modelKey: selection, bot: createdBot });
      setChatReady(true);
    } catch (reason) { if (!signal.aborted) setError(`Cannot get first reply: ${String(reason)}`); }
    finally {
      socket?.close();
      if (socketRef.current === socket) socketRef.current = null;
      if (!signal.aborted) setBusy(false);
    }
  }

  async function finish() {
    if (busy || !chatReady) return;
    const signal = lifetime.current.signal;
    setBusy(true);
    setError('');
    try {
      await api.onboarding.complete(undefined, { signal });
      if (signal.aborted) return;
      replies.delete(checkpointKey.current);
      try { sessionStorage.removeItem(checkpointKey.current); } catch { /* Storage is optional. */ }
      onCompleted();
    } catch (reason) { if (!signal.aborted) setError(`Cannot finish setup: ${String(reason)}`); }
    finally { if (!signal.aborted) setBusy(false); }
  }

  const index = stages.indexOf(stage);
  return <section className="neo-onboarding" aria-label="First-run setup" data-testid="onboarding-wizard">
    <Heading level={1}>Set up your workspace</Heading>
    <Text as="p">Choose a model, create a bot, and get your first reply. Channels can wait until later.</Text>
    <SetupTiming startedAt={startedAt.current} stepStartedAt={stepStartedAt} />
    {loading ? <Card padding={4} className="neo-onboarding-card">
      <div role="status" className="neo-onboarding-status"><Spinner label="Loading setup" /> <Text>Loading setup...</Text></div>
      <Skeleton height={24} width="65%" />
      <Skeleton height={48} />
    </Card> : loadError ? <Banner role="alert" status="error" title="Cannot load workspace setup"
      description={<Text as="p">Check your Gateway connection and try again. {loadError}</Text>}
      endContent={<Button label="Retry setup" onClick={() => setLoadAttempt((value) => value + 1)}>Retry</Button>} /> : <>
      <div className="neo-onboarding-progress">
        <Text data-testid="onboarding-progress">Step {index + 1} of {stages.length}</Text>
        <Stepper activeStep={index} label="Setup progress" horizontalOptions={{ minimumStepWidth: 112, collapsedVariant: 'withLabel' }}>
          {stages.map((item, position) => <Step key={item} step={position} label={labels[item]} isOptional={item === 'channel'} />)}
        </Stepper>
      </div>
      <Card padding={4} className="neo-onboarding-card">
      <div ref={cardRef} className="neo-onboarding-content" data-stage={stage}>
      {stage === 'owner' && <>
        <Heading level={2} tabIndex={-1}>Your workspace is ready</Heading>
        <Text as="p">The local workspace <strong data-testid="onboarding-workspace">{workspace}</strong> and owner account <strong data-testid="onboarding-owner">{owner}</strong> have been created.</Text>
        <Button label="Continue to model" data-testid="onboarding-owner-next" onClick={() => advance('model')}>Continue</Button>
      </>}
      {stage === 'model' && <>
        <Heading level={2} tabIndex={-1}>Choose your model</Heading>
        <SubscriptionOptions api={api} providers={providers} onSaved={(saved) => {
          setProviders((previous) => [...previous.filter((item) => item.id !== saved.id), saved]);
        }} deferHermes={<div className="subscription-row">
          <Heading level={3}>Hermes ? ChatGPT / Codex</Heading>
          <Text as="p">Sign in after creating your first bot to authorize its profile.</Text>
          <TextInput label="Codex model ID" value={codexModel} onChange={setCodexModel} isRequired width="100%" />
          <Button label="Use ChatGPT / Codex for Hermes" data-testid="onboarding-subscription-next" isDisabled={!codexModel.trim() || busy}
            onClick={() => { const chosen = codexModel.trim(); setSubscriptionModel(chosen); setCreatedBot(''); advance('bot', '', chosen); }}>Use ChatGPT / Codex</Button>
        </div>} />
        <Heading level={3}>OpenAI-compatible API</Heading>
        <Text as="p">Connect a hosted or local API. API keys are saved in the model vault.</Text>
        <LocalPresets disabled={busy} onSelect={(preset) => {
          setProviderId(preset.id); setProviderName(preset.name); setProviderUrl(preset.url);
          setProviderKey(''); setAddProvider(true);
        }} />
        {addProvider ? <form onSubmit={(event) => void saveProvider(event)} className="neo-onboarding-form">
          <label>Provider ID<input data-testid="onboarding-provider-id" pattern="[a-z][a-z0-9-]{0,47}" required value={providerId} onChange={(event) => setProviderId(event.target.value)} /></label>
          <label>Provider name<input value={providerName} onChange={(event) => setProviderName(event.target.value)} /></label>
          <label>API base URL<input data-testid="onboarding-provider-url" type="url" required value={providerUrl} onChange={(event) => setProviderUrl(event.target.value)} /></label>
          <label>API key<input data-testid="onboarding-provider-key" type="password" autoComplete="new-password" value={providerKey} onChange={(event) => setProviderKey(event.target.value)} placeholder="Optional for local providers" /></label>
          <div className="neo-onboarding-actions">
            <Button label="Save provider" data-testid="onboarding-provider-save" type="submit" isDisabled={busy}>Save provider</Button>
            {providers.some((provider) => provider.kind === 'openai-compatible') && <Button label="Choose existing provider" onClick={() => setAddProvider(false)}>Choose existing</Button>}
          </div>
        </form> : <form onSubmit={(event) => void saveModel(event)} className="neo-onboarding-form">
          <label>Provider
            <select data-testid="onboarding-provider" value={selectedProvider} onChange={(event) => setSelectedProvider(event.target.value)}>
              <option value="">Choose provider</option>
              {providers.filter((provider) => provider.kind === 'openai-compatible').map((provider) => <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>)}
            </select>
          </label>
          <label>Model ID<input data-testid="onboarding-model" value={model} onChange={(event) => setModel(event.target.value)} placeholder="Model ID" required /></label>
          <div className="neo-onboarding-actions">
            <Button label="Save model and continue" data-testid="onboarding-model-next" type="submit" isDisabled={!selectedProvider || !model.trim() || busy}>Save and continue</Button>
            <Button label="Add a provider" data-testid="onboarding-provider-add" onClick={() => setAddProvider(true)}>Add provider</Button>
            {configuredModel && <Button label="Keep configured model" onClick={() => { setSubscriptionModel(''); setCreatedBot(''); advance('bot', '', ''); }}>Keep current model</Button>}
          </div>
        </form>}
      </>}
      {stage === 'bot' && <>
        <Heading level={2} tabIndex={-1}>Create your first bot</Heading>
        <Text as="p">Give your bot a name. You can add more bots later.</Text>
        {hermes === 'checking' && <div role="status" className="neo-onboarding-status">
          <Spinner label="Checking Hermes" /><Text>Checking Hermes...</Text>
        </div>}
        {hermes === 'failed' && <Banner role="alert" status="error" title="Hermes is unavailable"
          description={<Text as="p">{hermesError}</Text>}
          endContent={<Button label="Retry Hermes check" onClick={() => setHermes('checking')}>Retry</Button>} />}
        {hermes === 'missing' && <>
          <div className="neo-onboarding-status"><StatusDot variant="warning" label="Installation required" /><Text>Hermes needs to be installed.</Text></div>
          <HermesInstall testId="onboarding-hermes-install" onReady={() => setHermes('ready')} />
        </>}
        {hermes === 'ready' && <div className="neo-onboarding-status" role="status">
          <StatusDot variant="success" label="Ready" /><Text>Hermes is ready.</Text>
        </div>}
        <form className="neo-onboarding-form" onSubmit={(event) => void createBot(event)}>
          <TextInput label="Bot name" data-testid="onboarding-bot-name" value={botName} onChange={setBotName} isRequired isDisabled={busy || !!(subscriptionModel && createdBot)} width="100%" />
          {error && <Banner role="alert" status="error" title="Could not create your bot" description={error} />}
          <div className="neo-onboarding-actions">
            <Button label="Create first bot" data-testid="onboarding-bot-create" type="submit" isDisabled={!botName.trim() || busy || hermes !== 'ready' || !!(subscriptionModel && createdBot)}>{busy ? 'Creating bot...' : 'Create bot'}</Button>
            {busy && <div role="status" className="neo-onboarding-status"><Spinner label="Creating bot" /><Timer /></div>}
          </div>
        </form>
        {subscriptionModel && createdBot && hermes === 'ready' && <HermesProfileSignIn key={createdBot} api={api} profile={createdBot} onApproved={completeSubscription} />}
      </>}
      {stage === 'channel' && <>
        <Heading level={2} tabIndex={-1}>Connect a channel (optional)</Heading>
        <Text as="p">Your bot <strong data-testid="onboarding-created-bot">{createdBot}</strong> is ready. You can add Telegram or another channel later.</Text>
        <div className="neo-onboarding-actions">
          <Button label="Continue without a channel" data-testid="onboarding-channel-next" onClick={() => advance('chat')}>Continue to first chat</Button>
          <Button variant="secondary" label="Configure channels" data-testid="onboarding-channels" onClick={() => onOpen('/settings/channels')}>Configure channels</Button>
        </div>
      </>}
      {stage === 'chat' && <>
        <Heading level={2} tabIndex={-1}>Get your first reply</Heading>
        <Text as="p">Send a message to <strong>{createdBot}</strong> to confirm the model and bot are working.</Text>
        <form className="neo-onboarding-form" onSubmit={(event) => void sendMessage(event)}>
          <TextArea label="Message" data-testid="onboarding-chat-message" rows={3} value={message} onChange={(value) => { setMessage(value); setChatReady(false); setReply(''); replies.delete(checkpointKey.current); }} isRequired isDisabled={busy} width="100%" />
          {!chatReady && <Button label="Send first message" type="submit" data-testid="onboarding-chat-send" isDisabled={!message.trim() || busy}>{busy ? 'Waiting for reply...' : 'Send message'}</Button>}
        </form>
        {busy && !chatReady && <div role="status" className="neo-onboarding-status" data-testid="onboarding-operation-timer"><Spinner label="Waiting for reply" /><Text>Waiting for reply</Text><Timer /></div>}
        {reply && <div className="neo-onboarding-reply" data-testid="onboarding-chat-reply" aria-live="polite">
          <Text>{createdBot}</Text><ChatMessageBubble variant="filled" width="100%">{reply}</ChatMessageBubble>
        </div>}
        {error && <Banner role="alert" status="error" title="Setup needs attention" description={error} />}
        {chatReady && <>
          <Banner status="success" title="Your bot replied successfully" description="Your workspace is ready to use." />
          <div className="neo-onboarding-actions"><Button label="Finish setup" data-testid="onboarding-finish" onClick={() => void finish()} isDisabled={busy}>{busy ? 'Finishing...' : 'Finish setup'}</Button></div>
        </>}
      </>}
      {stage === 'model' && error && <Banner role="alert" status="error" title="Cannot save setup options" description={error} />}
      </div>
      </Card>
    </>}
    <div className="neo-onboarding-actions">
      {!loading && !loadError && index > 0 && <Button variant="secondary" label="Previous setup step" isDisabled={busy} onClick={() => advance(stages[index - 1]!)}>Back</Button>}
      <Button variant="ghost" label="Skip setup for now" data-testid="onboarding-skip" isDisabled={busy} onClick={onSkip}>Skip for now</Button>
    </div>
  </section>;
}
