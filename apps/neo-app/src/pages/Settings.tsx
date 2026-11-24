import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type ExtensionStatus } from '@neometaharness/contracts';
import { Badge, Banner, Button, Card, Collapsible, EmptyState, Heading, NumberInput, SegmentedControl, SegmentedControlItem, Selector, Spinner, Switch, Text, TextInput } from '@neometaharness/ui';
import { checkForUpdates, getUpdateState, installUpdate, subscribeUpdateState, type UpdateInfo } from '../updater';
import { gatewayUrl, gatewayToken } from '../config';
import { appearanceModes, type Appearance } from '../appearance';
import './settings.css';

type Client = ContractRouterClient<typeof neoContract>;

const http = createORPCClient<Client>(
  new HttpLink({
    url: () => gatewayUrl(),
    headers: () => {
      const token = gatewayToken();
      return token ? { authorization: 'Bearer ' + token } : {};
    },
  })
);

interface SettingProp {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  secret?: boolean;
  minimum?: number;
  maximum?: number;
}

interface ExtensionSettingsSchema {
  [key: string]: unknown;
  type?: 'object';
  properties: Record<string, SettingProp>;
  required?: string[];
}

function SchemaField({
  extension,
  name,
  prop,
  value,
  isSecretSet,
  disabled,
  onChange,
  onInvalidChange,
}: {
  extension: string;
  name: string;
  prop: SettingProp;
  value: unknown;
  isSecretSet?: boolean;
  disabled: boolean;
  onChange: (val: unknown) => void;
  onInvalidChange: (invalid: boolean) => void;
}) {
  const title = prop.title ?? name;
  const inputId = `setting-input-${extension}-${name}`;
  const common = { label: title, description: prop.description, isDisabled: disabled, width: '100%' };
  let control;

  if (prop.secret) {
    control = <>
      <div data-testid={`setting-secret-status-${extension}-${name}`}>
        <Badge variant={isSecretSet ? 'success' : 'neutral'} label={isSecretSet ? 'Configured' : 'Not configured'} />
      </div>
      <TextInput {...common} data-testid={inputId} type="password" autoComplete="new-password"
        value={typeof value === 'string' ? value : ''}
        placeholder={isSecretSet ? 'Leave blank to keep existing secret' : 'Enter secret value'}
        onChange={onChange} />
    </>;
  } else if (prop.enum && prop.enum.length > 0) {
    const options = prop.enum.map((option) => ({ label: String(option), value: String(option) }));
    control = <Selector {...common} data-testid={`setting-select-${extension}-${name}`}
      options={options} value={String(value ?? prop.default ?? prop.enum[0])}
      onChange={(selected) => onChange(prop.enum!.find((option) => String(option) === selected))} />;
  } else if (prop.type === 'boolean') {
    control = <Switch {...common} data-testid={`setting-switch-${extension}-${name}`}
      value={Boolean(value ?? prop.default ?? false)} onChange={onChange} />;
  } else if (prop.type === 'number' || prop.type === 'integer') {
    control = <NumberInput {...common} data-testid={inputId} hasClear
      min={prop.minimum} max={prop.maximum} isIntegerOnly={prop.type === 'integer'}
      value={value === '' || value == null ? null : Number(value)}
      onEntryErrorChange={(error) => onInvalidChange(error !== null)}
      onChange={(number) => onChange(number ?? '')} />;
  } else {
    control = <TextInput {...common} data-testid={inputId}
      value={String(value ?? prop.default ?? '')} onChange={onChange} />;
  }

  return <div className="settings-field" data-testid={`setting-field-${name}`}>{control}</div>;
}

function ExtensionSchemaForm({
  extension,
  schema,
  unavailable,
  onDirtyChange,
}: {
  extension: string;
  schema: ExtensionSettingsSchema;
  unavailable: boolean;
  onDirtyChange: (extension: string, dirty: boolean) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const [secretFlags, setSecretFlags] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: 'success' | 'warning' | 'error'; message: string } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [savedDrafts, setSavedDrafts] = useState<Record<string, unknown>>({});
  const submitting = useRef(false);
  const [invalidFields, setInvalidFields] = useState<string[]>([]);
  const dirty = invalidFields.length > 0 || Object.keys(drafts).some((key) => !Object.is(drafts[key], savedDrafts[key]));
  useEffect(() => {
    onDirtyChange(extension, dirty || saving);
    return () => onDirtyChange(extension, false);
  }, [extension, dirty, saving, onDirtyChange]);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setLoadError('');
    http.settings.get({ extension })
      .then((res) => {
        if (disposed) return;
        const initialDrafts: Record<string, unknown> = {};
        const initialSecrets: Record<string, boolean> = {};
        const values = res.values ?? {};

        for (const [key, prop] of Object.entries(schema.properties ?? {})) {
          if (prop.secret) {
            const secretObj = values[key] as { set?: boolean } | undefined;
            const isSet = Boolean(secretObj?.set);
            initialSecrets[key] = isSet;
            initialDrafts[key] = ''; // write-only
          } else {
            initialDrafts[key] = values[key] ?? prop.default;
          }
        }
        setDrafts(initialDrafts);
        setSavedDrafts(initialDrafts);
        setSecretFlags(initialSecrets);
        setLoading(false);
      })
      .catch((err) => {
        if (!disposed) {
          setLoadError(String(err));
          setLoading(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [extension, attempt]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting.current || loading || loadError || unavailable || invalidFields.length > 0) return;
    submitting.current = true;
    setSaving(true);
    setStatus(null);
    try {
      const payload: Record<string, unknown> = {};
      for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        if (prop.secret) {
          const val = drafts[key];
          if (typeof val === 'string' && val.trim().length > 0) {
            payload[key] = val.trim();
          }
        } else if (prop.type === 'number' || prop.type === 'integer') {
          if (drafts[key] !== undefined && drafts[key] !== '') {
            payload[key] = Number(drafts[key]);
          }
        } else if (prop.type === 'string' && drafts[key] === '') {
          // Only a secret keeps its value when left empty. A cleared field returns to its default (null clears).
          payload[key] = null;
        } else {
          if (drafts[key] !== undefined && drafts[key] !== '') {
            payload[key] = drafts[key];
          }
        }
      }

      const res = await http.settings.set({ extension, values: payload });
      setStatus(res.warning ? { kind: 'warning', message: res.warning } : { kind: 'success', message: 'Saved successfully' });

      // Clear write-only inputs and update configured flags
      const updatedSecrets = { ...secretFlags };
      const updatedDrafts = { ...drafts };
      const resValues = res.values as Record<string, { set?: boolean }> | undefined;
      for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        if (prop.secret) {
          updatedDrafts[key] = '';
          updatedSecrets[key] = resValues?.[key]?.set === true;
        } else if (payload[key] === null) {
          updatedDrafts[key] = (res.values as Record<string, unknown> | undefined)?.[key] ?? prop.default ?? '';
        }
      }
      setDrafts(updatedDrafts);
      setSavedDrafts(updatedDrafts);
      setSecretFlags(updatedSecrets);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ kind: 'error', message });
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  if (loading) {
    return <div role="status" data-testid={`settings-loading-${extension}`}><Spinner label="Loading settings" /></div>;
  }

  if (loadError) return <Banner status="error" title="Could not load settings" description={loadError}
    endContent={<Button label="Retry" onClick={() => setAttempt((value) => value + 1)} />} />;

  return (
    <form
      data-testid={`settings-form-${extension}`}
      className="settings-form"
      onSubmit={handleSubmit}
    >
      {Object.entries(schema.properties ?? {}).map(([key, prop]) => (
        <SchemaField
          key={key}
          extension={extension}
          name={key}
          prop={prop}
          value={drafts[key]}
          isSecretSet={secretFlags[key]}
          disabled={saving || unavailable}
          onInvalidChange={(invalid) => setInvalidFields((fields) => invalid ? [...new Set([...fields, key])] : fields.filter((field) => field !== key))}
          onChange={(val) => setDrafts((prev) => ({ ...prev, [key]: val }))}
        />
      ))}
      <div className="settings-actions">
        <Button
          type="submit"
          label={`Save ${extension} settings`}
          data-testid={`settings-save-${extension}`}
          variant="primary"
          isLoading={saving}
          isDisabled={unavailable || invalidFields.length > 0}
        >
          {saving ? 'Saving...' : 'Save settings'}
        </Button>
        {dirty && <Badge variant="warning" label="Unsaved changes" />}
      </div>
      {status && <div data-testid={`settings-status-${extension}`} role={status.kind === 'error' ? 'alert' : 'status'}>
        <Banner status={status.kind} title={status.message} />
      </div>}
    </form>
  );
}

export default function Settings({ onOpen, appearance, onAppearanceChange, onDirtyChange }: {
  onOpen: (path: '/settings/channels' | '/settings/models' | '/settings/metrics' | '/onboarding' | '/extensions') => void;
  appearance: Appearance;
  onAppearanceChange: (mode: string) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [extensions, setExtensions] = useState<ExtensionStatus[]>([]);
  const latest = useRef(0);
  const [extensionsLoading, setExtensionsLoading] = useState(true);
  const [extensionsLoaded, setExtensionsLoaded] = useState(false);
  const [dirtyExtensions, setDirtyExtensions] = useState<string[]>([]);
  const reportDirty = useCallback((extension: string, dirty: boolean) => {
    setDirtyExtensions((previous) => dirty ? [...new Set([...previous, extension])] : previous.filter((id) => id !== extension));
  }, []);
  useEffect(() => {
    onDirtyChange(dirtyExtensions.length > 0);
  }, [dirtyExtensions, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const [extensionsError, setExtensionsError] = useState('');
  const listRequest = useRef(0);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>(getUpdateState);
  // Captured at render: the Install click sends exactly this {generation, version}, never a later state.
  const shownCandidate =
    updateInfo.available && updateInfo.version ? { generation: updateInfo.generation, version: updateInfo.version } : null;
  const native = (window as unknown as { __TAURI_INTERNALS__?: {
    invoke: (name: string) => Promise<string | null>;
  } }).__TAURI_INTERNALS__;

  useEffect(() => {
    return subscribeUpdateState(setUpdateInfo);
  }, []);

  const loadExtensions = () => {
    const request = ++listRequest.current;
    setExtensionsLoading(true);
    setExtensionsError('');
    void http.extensions.list().then((list) => {
      if (request !== listRequest.current) return;
      setExtensions(list);
      setExtensionsLoaded(true);
    }).catch((error) => {
      if (request === listRequest.current) setExtensionsError(String(error));
    }).finally(() => {
      if (request === listRequest.current) setExtensionsLoading(false);
    });
  };

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;

    loadExtensions();

    const subscribe = async () => {
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

          for await (const event of await stream.events.subscribe({ since: latest.current })) {
            if (disposed) break;
            latest.current = Math.max(latest.current, event.seq);
            if (event.type === 'extension.state') {
              setExtensions((prev) =>
                prev.map((ext) => (ext.id === event.extensionId ? { ...ext, status: event.status } : ext))
              );
              loadExtensions();
            }
          }
        } catch {
          if (!disposed) {
            await new Promise((r) => setTimeout(r, 1000));
          }
        } finally {
          try {
            socket?.close();
          } catch {}
        }
      }
    };

    void subscribe();

    return () => {
      disposed = true;
      ++listRequest.current;
      try {
        socket?.close();
      } catch {}
    };
  }, []);

  // Filter for enabled extensions that have a settings schema
  const configurableExtensions = extensions.filter(
    (ext) =>
      ext.status === 'running' &&
      ext.settingsVisible !== false &&
      ext.settings &&
      typeof ext.settings === 'object' &&
      Object.keys((ext.settings as Record<string, unknown>).properties || {}).length > 0
  );

  return (
    <section aria-label="Settings" className="settings-page">
      <Heading level={1}>Settings</Heading>
      <Card className="settings-group" padding={4}>
        <section aria-labelledby="appearance-heading" className="settings-appearance-section">
          <Heading id="appearance-heading" level={2}>Appearance</Heading>
          <Text as="p">Choose a color mode for this device.</Text>
          <SegmentedControl className="settings-appearance" value={appearance} onChange={onAppearanceChange} label="Color mode">
            {appearanceModes.map(({ value, label }) => <SegmentedControlItem key={value} value={value} label={label} />)}
          </SegmentedControl>
        </section>
      </Card>
      <section className="settings-group" aria-label="Workspace preferences">
        <Heading level={2}>Workspace</Heading>
        <div className="settings-destinations">
          <Card className="settings-destination" padding={4}>
            <Heading level={3}>Workspace setup</Heading>
            <Text as="p">Review your owner account, model, first bot, and channels.</Text>
            <Button label="Open workspace setup" data-testid="settings-onboarding-open" onClick={() => onOpen('/onboarding')}>Open setup</Button>
          </Card>
          <Card className="settings-destination" padding={4}>
            <Heading level={3}>Channels</Heading>
            <Text as="p">Manage messaging connections for your bots.</Text>
            <Button label="Manage channels" data-testid="settings-channels-open" onClick={() => onOpen('/settings/channels')}>Manage channels</Button>
          </Card>
          <Card className="settings-destination" padding={4}>
            <Heading level={3}>Models</Heading>
            <Text as="p">Providers, roles and bot overrides.</Text>
            <Button label="Manage models" data-testid="settings-models-open" onClick={() => onOpen('/settings/models')}>Manage models</Button>
          </Card>
          {extensions.some((ext) => ext.id === 'metrics' && ext.status === 'running') && <Card className="settings-destination" padding={4}>
            <Heading level={3}>Success metrics</Heading>
            <Text as="p">Review attention, learning and time-to-first-value measures from recorded activity.</Text>
            <Button label="View success metrics" data-testid="settings-metrics-open" onClick={() => onOpen('/settings/metrics')}>View metrics</Button>
          </Card>}
        </div>
      </section>

      {native && (
        <Card className="settings-group" padding={4}>
          <section aria-label="Desktop updates" className="settings-group">
          <Heading level={2}>Desktop updates</Heading>
          <div className="settings-actions">
            <Button label="Check for updates" data-testid="settings-update-check" isLoading={updateInfo.checking} onClick={() => void checkForUpdates()}>
              Check for updates
            </Button>
            {shownCandidate && (
              <Button label="Install and restart" data-testid="settings-update-install" isDisabled={dirtyExtensions.length > 0} onClick={() => void installUpdate(shownCandidate)}>
                Install and restart
              </Button>
            )}
          </div>
          {updateInfo.available && (
            <div style={{ margin: '0.5rem 0' }} data-testid="settings-update-available">
              <Badge variant="success" label={`Update available: ${updateInfo.version}`} />
            </div>
          )}
          {updateInfo.error ? <Banner status="error" title="Update failed" description={updateInfo.error} /> :
            updateInfo.status && <div role="status"><Text as="p">{updateInfo.status}</Text></div>}
          </section>
        </Card>
      )}

      <div className="settings-section">
        <Heading level={2}>Extension settings</Heading>
        <Text as="p">Configure settings for enabled extensions.</Text>
        {extensionsLoading && <div role="status"><Spinner label="Loading extensions" /></div>}
        {extensionsError && <Banner status="error" title="Could not load extensions" description={extensionsError}
          endContent={<Button label="Retry" onClick={loadExtensions} />} />}

        {extensionsLoaded && (configurableExtensions.length === 0 ? (
          !extensionsLoading && !extensionsError && <div data-testid="settings-no-extensions"><EmptyState title="No configurable extensions enabled"
            actions={<Button label="View extensions" onClick={() => onOpen('/extensions')} />} isCompact /></div>
        ) : (
          configurableExtensions.map((ext) => (
            <div
              key={ext.id}
              data-testid={`settings-extension-${ext.id}`}
              className="settings-extension-panel"
            >
              <Collapsible defaultIsOpen trigger={<Heading level={3}>{ext.id}</Heading>}>
              <ExtensionSchemaForm
                extension={ext.id}
                schema={ext.settings as unknown as ExtensionSettingsSchema}
                unavailable={Boolean(extensionsError)}
                onDirtyChange={reportDirty}
              />
              </Collapsible>
            </div>
          ))
        ))}
      </div>
    </section>
  );
}
