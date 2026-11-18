import { useEffect, useState, type FormEvent } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type ModelProviderRecord } from '@neometaharness/contracts';
import { Button } from '@neometaharness/ui';
import { gatewayToken, gatewayUrl } from '../config';
import './onboarding.css';

const api = createORPCClient<ContractRouterClient<typeof neoContract>>(new RPCLink({
  url: gatewayUrl(),
  headers: () => {
    const token = gatewayToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  },
}));

type Stage = 'owner' | 'model' | 'bot' | 'channel';
const stages: Stage[] = ['owner', 'model', 'bot', 'channel'];

export default function Onboarding({ onOpen, onSkip, onCompleted }: {
  onOpen: (path: string) => void;
  onSkip: () => void;
  onCompleted: () => void;
}) {
  const [stage, setStage] = useState<Stage>('owner');
  const [owner, setOwner] = useState('');
  const [providers, setProviders] = useState<ModelProviderRecord[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [model, setModel] = useState('');
  const [configuredModel, setConfiguredModel] = useState(false);
  const [botName, setBotName] = useState('first-bot');
  const [createdBot, setCreatedBot] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    void api.extensions.enable({ id: 'models' }).then(() =>
      Promise.all([api.onboarding.get(), api.x.models.providers.list(), api.x.models.roles.get()]))
      .then(([status, available, roles]) => {
        if (!mounted) return;
        setOwner(status.ownerName);
        setProviders(available);
        setSelectedProvider(roles.default?.providerId ?? available[0]?.id ?? '');
        setModel(roles.default?.model ?? '');
        setConfiguredModel(!!roles.default);
      })
      .catch(async (reason) => {
        if (!mounted) return;
        try {
          const status = await api.onboarding.get();
          if (mounted) setOwner(status.ownerName);
        } catch { /* show the original error */ }
        if (mounted) setError(`Cannot load setup options: ${String(reason)}`);
      })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  async function saveModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProvider || !model.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.x.models.roles.set({ role: 'default', providerId: selectedProvider, model: model.trim() });
      setConfiguredModel(true);
      setStage('bot');
    } catch (reason) { setError(`Cannot save model: ${String(reason)}`); }
    finally { setBusy(false); }
  }

  async function createBot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!botName.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.extensions.enable({ id: 'engine-hermes' });
      const created = await api.x['engine-hermes'].profiles.create({ name: botName.trim() });
      setCreatedBot(created.name);
      setStage('channel');
    } catch (reason) { setError(`Cannot create bot: ${String(reason)}`); }
    finally { setBusy(false); }
  }

  async function finish() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.onboarding.complete();
      onCompleted();
    } catch (reason) { setError(`Cannot finish setup: ${String(reason)}`); }
    finally { setBusy(false); }
  }

  return <section className="neo-onboarding" aria-label="First-run setup" data-testid="onboarding-wizard">
    <div className="neo-onboarding-kicker">WELCOME TO NEO META HARNESS</div>
    <h1>Set up your workspace</h1>
    <p className="neo-onboarding-intro">Connect a model and give your first bot a home. You can return to setup from Settings.</p>
    <nav className="neo-onboarding-progress" aria-label="Setup progress">
      {stages.map((item, index) => <span key={item} aria-current={item === stage ? 'step' : undefined}
        className={item === stage ? 'active' : ''}>{index + 1}. {item === 'owner' ? 'Owner' : item === 'model' ? 'Model' : item === 'bot' ? 'Bot' : 'Channel'}</span>)}
    </nav>

    {loading ? <p role="status">Loading setup…</p> : <div className="neo-onboarding-card">
      {stage === 'owner' && <>
        <h2>Owner account</h2>
        <p>Desktop mode has created your local owner account. You are signed in as <strong data-testid="onboarding-owner">{owner || 'workspace owner'}</strong>.</p>
        <Button label="Continue to model" data-testid="onboarding-owner-next" onClick={() => { setError(''); setStage('model'); }}>Continue</Button>
      </>}
      {stage === 'model' && <>
        <h2>Choose your model</h2>
        <p>Choose a provider already connected to your workspace and enter its model ID.</p>
        <form onSubmit={(event) => void saveModel(event)} className="neo-onboarding-form">
          <label>Provider
            <select data-testid="onboarding-provider" value={selectedProvider} onChange={(event) => setSelectedProvider(event.target.value)}>
              <option value="">Choose provider</option>
              {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>)}
            </select>
          </label>
          <label>Model ID
            <input data-testid="onboarding-model" value={model} onChange={(event) => setModel(event.target.value)} placeholder="Model ID" />
          </label>
          <div className="neo-onboarding-actions">
            <Button label="Save model and continue" data-testid="onboarding-model-next" type="submit" isDisabled={!selectedProvider || !model.trim() || busy}>Save and continue</Button>
            <Button label="Open model settings" data-testid="onboarding-model-settings" onClick={() => onOpen('/settings/models')}>Manage providers</Button>
            {configuredModel && <Button label="Keep configured model" onClick={() => setStage('bot')}>Keep current model</Button>}
          </div>
        </form>
      </>}
      {stage === 'bot' && <>
        <h2>Create your first bot</h2>
        <p>Name your bot. You can create more bots from Agents later.</p>
        <form className="neo-onboarding-form" onSubmit={(event) => void createBot(event)}>
          <label>Bot name
            <input data-testid="onboarding-bot-name" value={botName} onChange={(event) => setBotName(event.target.value)} required />
          </label>
          <Button label="Create first bot" data-testid="onboarding-bot-create" type="submit" isDisabled={!botName.trim() || busy}>Create bot</Button>
        </form>
      </>}
      {stage === 'channel' && <>
        <h2>Connect a channel</h2>
        <p>{createdBot && <>Your bot <strong data-testid="onboarding-created-bot">{createdBot}</strong> is ready. </>}Telegram and other channels can be configured whenever you need them.</p>
        <div className="neo-onboarding-actions">
          <Button label="Configure channels" data-testid="onboarding-channels" onClick={() => onOpen('/settings/channels')}>Configure channels</Button>
          <Button label="Finish setup" data-testid="onboarding-finish" isDisabled={busy} onClick={() => void finish()}>Finish setup</Button>
        </div>
      </>}
      {error && <p role="alert" className="neo-onboarding-error">{error}</p>}
    </div>}
    <Button label="Skip setup for now" data-testid="onboarding-skip" onClick={onSkip}>Skip for now</Button>
  </section>;
}
