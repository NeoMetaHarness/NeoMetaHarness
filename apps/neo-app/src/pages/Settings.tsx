import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type ExtensionStatus, type GatewayEvent } from '@neometaharness/contracts';
import { Badge, Button, Switch } from '@neometaharness/ui';
import { checkForUpdates, getUpdateState, installUpdate, subscribeUpdateState, type UpdateInfo } from '../updater';
import { gatewayUrl, gatewayToken } from '../config';
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
  onChange,
}: {
  extension: string;
  name: string;
  prop: SettingProp;
  value: unknown;
  isSecretSet?: boolean;
  onChange: (val: unknown) => void;
}) {
  const title = prop.title ?? name;
  const isSecret = Boolean(prop.secret);

  if (isSecret) {
    return (
      <div className="settings-field" data-testid={`setting-field-${name}`}>
        <label htmlFor={`field-${extension}-${name}`}>
          <span>{title}</span>
          <span
            className={`settings-secret-status ${isSecretSet ? 'configured' : 'unset'}`}
            data-testid={`setting-secret-status-${extension}-${name}`}
          >
            {isSecretSet ? 'Configured' : 'Not configured'}
          </span>
        </label>
        {prop.description && <small>{prop.description}</small>}
        <input
          id={`field-${extension}-${name}`}
          data-testid={`setting-input-${extension}-${name}`}
          type="password"
          autoComplete="new-password"
          value={typeof value === 'string' ? value : ''}
          placeholder={isSecretSet ? 'Leave blank to keep existing secret' : 'Enter secret value'}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }

  if (prop.enum && prop.enum.length > 0) {
    const currentVal = value !== undefined ? String(value) : (prop.default !== undefined ? String(prop.default) : String(prop.enum[0]));
    return (
      <div className="settings-field" data-testid={`setting-field-${name}`}>
        <label htmlFor={`field-${extension}-${name}`}>{title}</label>
        {prop.description && <small>{prop.description}</small>}
        <select
          id={`field-${extension}-${name}`}
          data-testid={`setting-select-${extension}-${name}`}
          value={currentVal}
          onChange={(e) => onChange(e.target.value)}
        >
          {prop.enum.map((opt) => (
            <option key={String(opt)} value={String(opt)}>
              {String(opt)}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (prop.type === 'boolean') {
    const checked = Boolean(value ?? prop.default ?? false);
    return (
      <div className="settings-field" data-testid={`setting-field-${name}`}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span>{title}</span>
          <Switch
            data-testid={`setting-switch-${extension}-${name}`}
            label={title} value={checked}
            onChange={(selected) => onChange(selected)}
          />
        </label>
        {prop.description && <small>{prop.description}</small>}
      </div>
    );
  }

  if (prop.type === 'number' || prop.type === 'integer') {
    const numVal = value !== undefined ? value : (prop.default ?? '');
    return (
      <div className="settings-field" data-testid={`setting-field-${name}`}>
        <label htmlFor={`field-${extension}-${name}`}>{title}</label>
        {prop.description && <small>{prop.description}</small>}
        <input
          id={`field-${extension}-${name}`}
          data-testid={`setting-input-${extension}-${name}`}
          type="number"
          min={prop.minimum}
          max={prop.maximum}
          value={numVal === '' ? '' : Number(numVal)}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === '' ? '' : Number(v));
          }}
        />
      </div>
    );
  }

  // Default string
  const strVal = value !== undefined ? String(value) : (prop.default !== undefined ? String(prop.default) : '');
  return (
    <div className="settings-field" data-testid={`setting-field-${name}`}>
      <label htmlFor={`field-${extension}-${name}`}>{title}</label>
      {prop.description && <small>{prop.description}</small>}
      <input
        id={`field-${extension}-${name}`}
        data-testid={`setting-input-${extension}-${name}`}
        type="text"
        value={strVal}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function ExtensionSchemaForm({
  extension,
  schema,
}: {
  extension: string;
  schema: ExtensionSettingsSchema;
}) {
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const [secretFlags, setSecretFlags] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string>('');

  useEffect(() => {
    let disposed = false;
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
        setSecretFlags(initialSecrets);
        setLoading(false);
      })
      .catch((err) => {
        if (!disposed) {
          setStatus(`Failed to load settings: ${String(err)}`);
          setLoading(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [extension]);

  const handleSubmit = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (saving) return;
    setSaving(true);
    setStatus('');
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
        } else {
          if (drafts[key] !== undefined && drafts[key] !== '') {
            payload[key] = drafts[key];
          }
        }
      }

      const res = await http.settings.set({ extension, values: payload });
      setStatus(res.warning ?? 'Saved successfully');

      // Clear write-only inputs and update configured flags
      const updatedSecrets = { ...secretFlags };
      const updatedDrafts = { ...drafts };
      const resValues = res.values as Record<string, { set?: boolean }> | undefined;
      for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        if (prop.secret) {
          updatedDrafts[key] = '';
          updatedSecrets[key] = resValues?.[key]?.set === true;
        }
      }
      setDrafts(updatedDrafts);
      setSecretFlags(updatedSecrets);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`Error: ${message}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div data-testid={`settings-loading-${extension}`}>Loading ${extension} settings...</div>;
  }

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
          onChange={(val) => setDrafts((prev) => ({ ...prev, [key]: val }))}
        />
      ))}
      <div className="settings-actions">
        <Button
          type="submit"
          label={`Save ${extension} settings`}
          data-testid={`settings-save-${extension}`}
          isDisabled={saving}
          onClick={() => {
            void handleSubmit();
          }}
        >
          {saving ? 'Saving...' : 'Save settings'}
        </Button>
        {status && (
          <span
            data-testid={`settings-status-${extension}`}
            className="settings-status"
          >
            {status}
          </span>
        )}
      </div>
    </form>
  );
}

export default function Settings({ onOpen }: { onOpen: (path: '/settings/channels' | '/settings/models' | '/settings/metrics' | '/onboarding') => void }) {
  const [extensions, setExtensions] = useState<ExtensionStatus[]>([]);
  const latest = useRef(0);
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
    http.extensions.list().then((list) => {
      setExtensions(list);
    }).catch(() => {});
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
      <h1>Settings</h1>

      <h2>Workspace setup</h2>
      <p>Review your owner account, model, first bot, and channels.</p>
      <Button label="Open workspace setup" data-testid="settings-onboarding-open" onClick={() => onOpen('/onboarding')}>
        Open setup
      </Button>

      <h2>Channels</h2>
      <p>Manage messaging connections for your bots.</p>
      <Button label="Manage channels" data-testid="settings-channels-open" onClick={() => onOpen('/settings/channels')}>
        Manage channels
      </Button>

      <h2>Models</h2>
      <p>Providers, roles and bot overrides.</p>
      <Button label="Manage models" data-testid="settings-models-open" onClick={() => onOpen('/settings/models')}>
        Manage models
      </Button>

      {extensions.some((ext) => ext.id === 'metrics' && ext.status === 'running') && <>
        <h2>Success metrics</h2>
        <p>Review attention, learning and time-to-first-value measures from recorded activity.</p>
        <Button label="View success metrics" data-testid="settings-metrics-open" onClick={() => onOpen('/settings/metrics')}>
          View metrics
        </Button>
      </>}

      {native && (
        <section aria-label="Desktop updates">
          <h2>Desktop updates</h2>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
            <Button label="Check for updates" data-testid="settings-update-check" onClick={() => void checkForUpdates()}>
              Check for updates
            </Button>
            {shownCandidate && (
              <Button label="Install and restart" data-testid="settings-update-install" onClick={() => void installUpdate(shownCandidate)}>
                Install and restart
              </Button>
            )}
          </div>
          {updateInfo.available && (
            <div style={{ margin: '0.5rem 0' }} data-testid="settings-update-available">
              <Badge variant="success" label={`Update available: ${updateInfo.version}`} />
            </div>
          )}
          {updateInfo.status && <p role="status">{updateInfo.status}</p>}
        </section>
      )}

      <div className="settings-section">
        <h2>Extension Settings</h2>
        <p>Configure settings for enabled extensions.</p>

        {configurableExtensions.length === 0 ? (
          <p data-testid="settings-no-extensions">No configurable extensions enabled.</p>
        ) : (
          configurableExtensions.map((ext) => (
            <div
              key={ext.id}
              data-testid={`settings-extension-${ext.id}`}
              className="settings-extension-panel"
            >
              <h3>{ext.id}</h3>
              <ExtensionSchemaForm
                extension={ext.id}
                schema={ext.settings as unknown as ExtensionSettingsSchema}
              />
            </div>
          ))
        )}
      </div>
    </section>
  );
}
