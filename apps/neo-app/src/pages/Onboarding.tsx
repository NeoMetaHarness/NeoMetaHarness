import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type ModelProviderRecord } from '@neometaharness/contracts';
import { Button } from '@neometaharness/ui';
import { gatewayToken, gatewayUrl } from '../config';
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
  owner: 'Workspace & owner', model: 'Model', bot: 'Bot', channel: 'Channel (optional)', chat: 'First reply',
};
const formatTime = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export default function Onboarding({ onOpen, onSkip, onCompleted }: {
  onOpen: (path: string) => void;
  onSkip: () => void;
  onCompleted: () => void;
}) {
  const [stage, setStage] = useState<Stage>('owner');
  const [owner, setOwner] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [providers, setProviders] = useState<ModelProviderRecord[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [model, setModel] = useState('gpt-4.1-mini');
  const [configuredModel, setConfiguredModel] = useState(false);
  const [addProvider, setAddProvider] = useState(false);
  const [providerId, setProviderId] = useState('my-provider');
  const [providerName, setProviderName] = useState('OpenAI-compatible');
  const [providerUrl, setProviderUrl] = useState('https://api.openai.com/v1');
  const [providerKey, setProviderKey] = useState('');
  const [botName, setBotName] = useState('first-bot');
  const [createdBot, setCreatedBot] = useState('');
  const [message, setMessage] = useState('Hi! Please introduce yourself in one sentence.');
  const [reply, setReply] = useState('');
  const [chatReady, setChatReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [stepTimes, setStepTimes] = useState<Partial<Record<Stage, number>>>({});
  const startedAt = useRef(Date.now());
  const stepStartedAt = useRef(Date.now());
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(interval);
      socketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    void api.extensions.enable({ id: 'models' }).then(() =>
      Promise.all([api.onboarding.get(), api.x.models.providers.list(), api.x.models.roles.get()]))
      .then(([status, available, roles]) => {
        if (!mounted) return;
        setOwner(status.ownerName);
        setWorkspace(status.workspaceName);
        setProviders(available);
        setSelectedProvider(roles.default?.providerId ?? available[0]?.id ?? '');
        setModel(roles.default?.model ?? 'gpt-4.1-mini');
        setConfiguredModel(!!roles.default);
        setAddProvider(available.length === 0);
      })
      .catch(async (reason) => {
        if (!mounted) return;
        try {
          const status = await api.onboarding.get();
          if (mounted) { setOwner(status.ownerName); setWorkspace(status.workspaceName); }
        } catch { /* preserve the original error */ }
        if (mounted) setError(`Cannot load setup options: ${String(reason)}`);
      })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  function advance(next: Stage) {
    setStepTimes((previous) => ({ ...previous, [stage]: Date.now() - stepStartedAt.current }));
    stepStartedAt.current = Date.now();
    setError('');
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
    if (!selectedProvider || !model.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.x.models.roles.set({ role: 'default', providerId: selectedProvider, model: model.trim() });
      setConfiguredModel(true);
      advance('bot');
    } catch (reason) { setError(`Cannot save model: ${String(reason)}`); }
    finally { setBusy(false); }
  }

  async function createBot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!botName.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const enabled = await api.extensions.enable({ id: 'engine-hermes' });
      if (enabled.status !== 'running') throw new Error(enabled.reason || 'Hermes engine unavailable');
      const created = await api.x['engine-hermes'].profiles.create({ name: botName.trim() });
      setCreatedBot(created.name);
      advance('channel');
    } catch (reason) { setError(`Cannot create bot: ${String(reason)}`); }
    finally { setBusy(false); }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!createdBot || !message.trim() || busy) return;
    setBusy(true);
    setChatReady(false);
    setReply('');
    setError('');
    let text = '';
    try {
      const started = await api.x['engine-hermes'].runs.start({ profile: createdBot, input: message.trim() });
      const token = gatewayToken();
      const url = gatewayUrl().replace(/^http/, 'ws') + '/ws';
      const socket = token ? new WebSocket(url, ['bearer.' + token]) : new WebSocket(url);
      socketRef.current = socket;
      const stream = createORPCClient<Client>(new WebSocketLink({ websocket: socket }));
      let completed = false;
      for await (const event of await stream.x['engine-hermes'].runs.events({ profile: createdBot, runId: started.run_id })) {
        if (event.kind === 'text.delta') {
          text += event.textDelta ?? '';
          setReply(text);
        }
        if (event.type === 'run.failed' || event.type === 'run.cancelled' || event.type === 'run.interrupted') {
          throw new Error(`Bot run ${event.type}`);
        }
        if (event.type === 'run.completed') { completed = true; break; }
      }
      if (!completed || !text.trim()) throw new Error('Bot did not finish with a reply. Try again.');
      setChatReady(true);
    } catch (reason) { setError(`Cannot get first reply: ${String(reason)}`); }
    finally {
      socketRef.current?.close();
      socketRef.current = null;
      setBusy(false);
    }
  }

  async function finish() {
    if (busy || !chatReady) return;
    setBusy(true);
    setError('');
    try {
      await api.onboarding.complete();
      onCompleted();
    } catch (reason) { setError(`Cannot finish setup: ${String(reason)}`); }
    finally { setBusy(false); }
  }

  const index = stages.indexOf(stage);
  return <section className="neo-onboarding" aria-label="First-run setup" data-testid="onboarding-wizard">
    <div className="neo-onboarding-kicker">WELCOME TO NEO META HARNESS</div>
    <h1>Set up your workspace</h1>
    <p className="neo-onboarding-intro">Choose a model, create a bot, and get your first reply. Channels can wait until later.</p>
    <div className="neo-onboarding-timing" role="status" aria-live="off">
      <span data-testid="onboarding-progress">Step {index + 1} of {stages.length}</span>
      <span data-testid="onboarding-step-timer">This step {formatTime(now - stepStartedAt.current)}</span>
      <span data-testid="onboarding-total-timer">Total {formatTime(now - startedAt.current)}</span>
    </div>
    <progress aria-label="Setup completion" value={index} max={stages.length} data-testid="onboarding-progress-bar" />
    <nav className="neo-onboarding-progress" aria-label="Setup progress">
      {stages.map((item, position) => <span key={item} aria-current={item === stage ? 'step' : undefined}
        className={item === stage ? 'active' : ''}>{position + 1}. {labels[item]}
        {stepTimes[item] !== undefined && <small> {formatTime(stepTimes[item])}</small>}</span>)}
    </nav>

    {loading ? <p role="status">Loading setup…</p> : <div className="neo-onboarding-card">
      {stage === 'owner' && <>
        <h2>Your workspace is ready</h2>
        <p>The local workspace <strong data-testid="onboarding-workspace">{workspace || 'Default Workspace'}</strong> and owner account <strong data-testid="onboarding-owner">{owner || 'Workspace owner'}</strong> have been created.</p>
        <Button label="Continue to model" data-testid="onboarding-owner-next" onClick={() => advance('model')}>Continue</Button>
      </>}
      {stage === 'model' && <>
        <h2>Choose your model</h2>
        <p>Use an OpenAI-compatible model provider. Credentials are saved securely in the model vault.</p>
        {addProvider ? <form onSubmit={(event) => void saveProvider(event)} className="neo-onboarding-form">
          <label>Provider ID<input data-testid="onboarding-provider-id" pattern="[a-z][a-z0-9-]{0,47}" required value={providerId} onChange={(event) => setProviderId(event.target.value)} /></label>
          <label>Provider name<input value={providerName} onChange={(event) => setProviderName(event.target.value)} /></label>
          <label>API base URL<input data-testid="onboarding-provider-url" type="url" required value={providerUrl} onChange={(event) => setProviderUrl(event.target.value)} /></label>
          <label>API key<input data-testid="onboarding-provider-key" type="password" autoComplete="new-password" value={providerKey} onChange={(event) => setProviderKey(event.target.value)} placeholder="Optional for local providers" /></label>
          <div className="neo-onboarding-actions">
            <Button label="Save provider" data-testid="onboarding-provider-save" type="submit" isDisabled={busy}>Save provider</Button>
            {providers.length > 0 && <Button label="Choose existing provider" onClick={() => setAddProvider(false)}>Choose existing</Button>}
          </div>
        </form> : <form onSubmit={(event) => void saveModel(event)} className="neo-onboarding-form">
          <label>Provider
            <select data-testid="onboarding-provider" value={selectedProvider} onChange={(event) => setSelectedProvider(event.target.value)}>
              <option value="">Choose provider</option>
              {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>)}
            </select>
          </label>
          <label>Model ID<input data-testid="onboarding-model" value={model} onChange={(event) => setModel(event.target.value)} placeholder="Model ID" required /></label>
          <div className="neo-onboarding-actions">
            <Button label="Save model and continue" data-testid="onboarding-model-next" type="submit" isDisabled={!selectedProvider || !model.trim() || busy}>Save and continue</Button>
            <Button label="Add a provider" data-testid="onboarding-provider-add" onClick={() => setAddProvider(true)}>Add provider</Button>
            {configuredModel && <Button label="Keep configured model" onClick={() => advance('bot')}>Keep current model</Button>}
          </div>
        </form>}
      </>}
      {stage === 'bot' && <>
        <h2>Create your first bot</h2>
        <p>Give your bot a name. You can add more bots later.</p>
        <form className="neo-onboarding-form" onSubmit={(event) => void createBot(event)}>
          <label>Bot name<input data-testid="onboarding-bot-name" value={botName} onChange={(event) => setBotName(event.target.value)} required /></label>
          <Button label="Create first bot" data-testid="onboarding-bot-create" type="submit" isDisabled={!botName.trim() || busy}>Create bot</Button>
        </form>
      </>}
      {stage === 'channel' && <>
        <h2>Connect a channel (optional)</h2>
        <p>Your bot <strong data-testid="onboarding-created-bot">{createdBot}</strong> is ready. You can add Telegram or another channel later.</p>
        <div className="neo-onboarding-actions">
          <Button label="Configure channels" data-testid="onboarding-channels" onClick={() => onOpen('/settings/channels')}>Configure channels</Button>
          <Button label="Continue without a channel" data-testid="onboarding-channel-next" onClick={() => advance('chat')}>Continue to first chat</Button>
        </div>
      </>}
      {stage === 'chat' && <>
        <h2>Get your first reply</h2>
        <p>Send a message to <strong>{createdBot}</strong> to confirm the model and bot are working.</p>
        <form className="neo-onboarding-form" onSubmit={(event) => void sendMessage(event)}>
          <label>Message<textarea data-testid="onboarding-chat-message" rows={3} value={message} onChange={(event) => setMessage(event.target.value)} required /></label>
          <Button label="Send first message" type="submit" data-testid="onboarding-chat-send" isDisabled={!message.trim() || busy}> {busy ? 'Waiting for reply…' : 'Send message'}</Button>
        </form>
        {reply && <div className="neo-onboarding-reply" data-testid="onboarding-chat-reply" aria-live="polite"><strong>{createdBot}</strong><p>{reply}</p></div>}
        {chatReady && <div className="neo-onboarding-actions"><Button label="Finish setup" data-testid="onboarding-finish" onClick={() => void finish()} isDisabled={busy}>Finish setup</Button></div>}
      </>}
      {error && <p role="alert" className="neo-onboarding-error">{error}</p>}
    </div>}
    <Button label="Skip setup for now" data-testid="onboarding-skip" onClick={onSkip}>Skip for now</Button>
  </section>;
}
