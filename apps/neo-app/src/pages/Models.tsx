import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type ModelProviderRecord, type ModelRoleName,
  type ModelRolesRecord, type ModelSelectionRecord } from '@neometaharness/contracts';
import { Banner, Button, Card, Heading, Text } from '@neometaharness/ui';
import { gatewayUrl, gatewayToken } from '../config';
import { LocalPresets, SubscriptionOptions } from './SubscriptionOptions';
import './models.css';

type Client = ContractRouterClient<typeof neoContract>;
type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer';
const rpc = createORPCClient<Client>(new RPCLink({
  url: gatewayUrl(),
  headers: () => {
    const token = gatewayToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  },
}));
const modelApi = rpc.x.models;
const roleNames: ModelRoleName[] = ['default', 'fast', 'reasoning', 'coding', 'eval'];
const validProfile = /^(?:default|[a-z][a-z0-9_-]{0,47})$/;

export default function Models() {
  const [providers, setProviders] = useState<ModelProviderRecord[]>([]);
  const [roles, setRoles] = useState<ModelRolesRecord>({});
  const [roleDrafts, setRoleDrafts] = useState<ModelRolesRecord>({});
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [profile, setProfile] = useState('');
  const [override, setOverride] = useState<Partial<ModelSelectionRecord>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [workspaceRole, setWorkspaceRole] = useState<WorkspaceRole | null | undefined>(undefined);
  const canManage = workspaceRole === 'owner' || workspaceRole === 'admin';

  const refresh = useCallback(async () => {
    const [nextProviders, nextRoles] = await Promise.all([modelApi.providers.list(), modelApi.roles.get()]);
    setProviders(nextProviders);
    setRoles(nextRoles);
    setRoleDrafts(nextRoles);
  }, []);

  useEffect(() => { void refresh().catch(() => setError('Model Hub is unavailable. Enable it below.')); }, [refresh]);

  useEffect(() => {
    const controller = new AbortController();
    const token = gatewayToken();
    void fetch(`${gatewayUrl()}/auth/organization/get-active-member-role`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error('Workspace role unavailable');
      const result = await response.json() as { role?: unknown };
      const role = result.role;
      if (!controller.signal.aborted) setWorkspaceRole(
        role === 'owner' || role === 'admin' || role === 'member' || role === 'viewer' ? role : null,
      );
    }).catch(() => { if (!controller.signal.aborted) setWorkspaceRole(null); });
    return () => controller.abort();
  }, []);

  async function perform(label: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setError('');
    setNotice('');
    try { await action(); } catch (reason) { setError(String(reason)); }
    finally { setBusy(''); }
  }

  function editProvider(provider: ModelProviderRecord) {
    if (provider.kind !== 'openai-compatible') return;
    setId(provider.id);
    setName(provider.name);
    setBaseUrl(provider.baseUrl);
    setApiKey('');
  }

  function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!id || !baseUrl || busy) return;
    void perform('provider', async () => {
      await modelApi.providers.put({ id, name: name || id, kind: 'openai-compatible', baseUrl,
        ...(apiKey ? { apiKey } : {}) });
      setApiKey('');
      await refresh();
      setNotice(`Saved provider ${id}`);
    });
  }

  async function enable() {
    await perform('enable', async () => {
      const result = await rpc.extensions.enable({ id: 'models' });
      if (result.status !== 'running') throw new Error(result.reason || 'Model Hub could not start');
      await refresh();
      setNotice('Model Hub enabled');
    });
  }

  function saveRole(role: ModelRoleName) {
    const draft = roleDrafts[role];
    if (!draft?.providerId || !draft.model.trim() || busy) return;
    void perform(`role-${role}`, async () => {
      await modelApi.roles.set({ role, providerId: draft.providerId, model: draft.model.trim() });
      await refresh();
      setNotice(`Saved ${role} role`);
    });
  }

  function loadOverride() {
    if (!validProfile.test(profile) || busy) return;
    void perform('override-load', async () => {
      const result = await modelApi.override.get({ profile });
      setOverride(result.selection ?? {});
      setNotice(result.selection ? `Loaded ${profile}` : `No override for ${profile}`);
    });
  }

  function saveOverride(clear: boolean) {
    if (!validProfile.test(profile) || busy || (!clear && (!override.providerId || !override.model?.trim()))) return;
    void perform('override-save', async () => {
      await modelApi.override.set({ profile,
        ...(clear ? {} : { providerId: override.providerId, model: override.model!.trim() }) });
      if (clear) setOverride({});
      setNotice(clear ? `Cleared override for ${profile}` : `Saved override for ${profile}`);
    });
  }

  // The page is ready once the workspace role is known (undefined = still loading; null = unknown, read-only).
  return <main className="models-page" data-testid={workspaceRole === undefined ? undefined : 'settings-models'}
    aria-busy={workspaceRole === undefined}>
    <header className="models-heading"><Text>Settings / Models</Text><Heading level={1}>Models</Heading></header>
    <Text as="p">Connect model providers and assign models to agent roles. API keys are stored in the vault.</Text>
    {error && <Banner role="alert" status="error" title={error} endContent={canManage ? <Button label="Enable Model Hub" isDisabled={!!busy}
      onClick={() => void enable()}>Enable Model Hub</Button> : undefined} />}
    {notice && <Banner role="status" status="success" title={notice} />}
    <SubscriptionOptions api={rpc} providers={providers} canManage={canManage} onSaved={(saved) => {
      setProviders((previous) => [...previous.filter((item) => item.id !== saved.id), saved]);
    }} />

    <Card className="models-panel" padding={4}>
      <Heading level={2} id="models-providers">Providers</Heading>
      {canManage && <>
        <LocalPresets disabled={!!busy} onSelect={(preset) => {
          setId(preset.id); setName(preset.name); setBaseUrl(preset.url); setApiKey('');
        }} />
        <form onSubmit={saveProvider} className="models-form">
          <label>Provider ID<input data-testid="models-provider-id" required value={id} placeholder="my-provider"
            pattern="[a-z][a-z0-9-]{0,47}" onChange={(event) => setId(event.target.value)} /></label>
          <label>Display name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Base URL<input data-testid="models-provider-url" type="url" required value={baseUrl}
            placeholder="https://example.com/v1" onChange={(event) => setBaseUrl(event.target.value)} /></label>
          <label>API key (write-only)<input data-testid="models-provider-key" type="password" autoComplete="new-password"
            value={apiKey} placeholder="Leave blank to keep existing key" onChange={(event) => setApiKey(event.target.value)} /></label>
          <Button type="submit" label="Save provider" data-testid="models-save-provider"
            isDisabled={!!busy || !id || !baseUrl}>Save provider</Button>
        </form>
      </>}
      <ul className="models-list">{providers.map((provider) => <li key={provider.id}>
        <div><strong>{provider.name}</strong><small>{provider.id} · {provider.kind === 'openai-compatible'
          ? `${provider.baseUrl} · ${provider.hasKey ? 'Key saved' : 'No key'}`
          : `${provider.vendor} subscription · ${provider.status}`}</small></div>
        {canManage && <div className="models-actions">
          <Button label={`Edit ${provider.id}`} variant="secondary" isDisabled={!!busy || provider.kind !== 'openai-compatible'}
            onClick={() => editProvider(provider)}>Edit</Button>
          <Button label={`Test ${provider.id}`} variant="secondary" data-testid={`models-test-${provider.id}`}
            isDisabled={!!busy || provider.kind !== 'openai-compatible'} onClick={() => void perform('test', async () => {
              const result = await modelApi.providers.test({ id: provider.id });
              setNotice(result.ok ? `${provider.id} connected (${result.models} models)` : `${provider.id} failed (HTTP ${result.status})`);
            })}>Test connection</Button>
          <Button label={`Delete ${provider.id}`} variant="secondary" isDisabled={!!busy}
            onClick={() => void perform('delete', async () => {
              await modelApi.providers.delete({ id: provider.id });
              await refresh();
              setNotice(`Deleted provider ${provider.id}`);
            })}>Delete</Button>
        </div>}
      </li>)}</ul>
    </Card>

    {canManage && <Card className="models-panel" padding={4}>
      <Heading level={2} id="models-roles">Role mapping</Heading>
      {roleNames.map((role) => <div key={role} className="models-role">
        <strong>{role}</strong>
        <label>Provider<select aria-label={`${role} provider`} data-testid={`models-role-${role}-provider`}
          value={roleDrafts[role]?.providerId ?? ''} onChange={(event) => setRoleDrafts((drafts) => ({
            ...drafts, [role]: { providerId: event.target.value, model: drafts[role]?.model ?? '' },
          }))}>
          <option value="">Select provider</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
        </select></label>
        <label>Model<input aria-label={`${role} model`} data-testid={`models-role-${role}-model`}
          value={roleDrafts[role]?.model ?? ''} onChange={(event) => setRoleDrafts((drafts) => ({
            ...drafts, [role]: { providerId: drafts[role]?.providerId ?? '', model: event.target.value },
          }))} /></label>
        <Button label={`Save ${role} role`} data-testid={`models-save-role-${role}`}
          isDisabled={!!busy || !roleDrafts[role]?.providerId || !roleDrafts[role]?.model?.trim()}
          onClick={() => saveRole(role)}>Save</Button>
        {roles[role] && <small>Saved {roles[role]!.providerId} / {roles[role]!.model}</small>}
      </div>)}
    </Card>}

    {canManage && <Card className="models-panel" padding={4}>
      <Heading level={2} id="models-override">Per-bot override</Heading>
      <div className="models-form">
        <label>Bot profile<input data-testid="models-bot-profile" value={profile} placeholder="bot1"
          onChange={(event) => { setProfile(event.target.value); setOverride({}); }} /></label>
        <Button label="Load bot override" variant="secondary" isDisabled={!!busy || !validProfile.test(profile)}
          onClick={loadOverride}>Load override</Button>
        <label>Provider<select aria-label="Override provider" data-testid="models-override-provider"
          value={override.providerId ?? ''} onChange={(event) => setOverride((current) => ({ ...current, providerId: event.target.value }))}>
          <option value="">Select provider</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
        </select></label>
        <label>Model<input aria-label="Override model" data-testid="models-override-model"
          value={override.model ?? ''} onChange={(event) => setOverride((current) => ({ ...current, model: event.target.value }))} /></label>
        <div className="models-actions">
          <Button label="Save bot override" data-testid="models-save-override"
            isDisabled={!!busy || !validProfile.test(profile) || !override.providerId || !override.model?.trim()}
            onClick={() => saveOverride(false)}>Save override</Button>
          <Button label="Clear bot override" variant="secondary" isDisabled={!!busy || !validProfile.test(profile)}
            onClick={() => saveOverride(true)}>Clear override</Button>
        </div>
      </div>
    </Card>}
  </main>;
}
