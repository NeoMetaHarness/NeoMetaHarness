import { Button } from '@neometaharness/ui';
import { useState } from 'react';

export default function Settings({ onOpen }: { onOpen: (path: '/settings/channels' | '/settings/models' | '/onboarding') => void }) {
  const [updateStatus, setUpdateStatus] = useState('');
  const native = (window as unknown as { __TAURI_INTERNALS__?: {
    invoke: (name: string) => Promise<string | null>;
  } }).__TAURI_INTERNALS__;
  async function checkUpdates() {
    setUpdateStatus('Checking for updates…');
    try {
      const version = await native?.invoke('check_for_updates');
      setUpdateStatus(version ? `Version ${version} is available` : 'No newer version found');
    } catch (error) {
      setUpdateStatus(String(error));
    }
  }
  return <section aria-label="Settings">
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
    {native && <section aria-label="Desktop updates">
      <h2>Desktop updates</h2>
      <Button label="Check for updates" data-testid="settings-update-check" onClick={() => void checkUpdates()}>
        Check for updates
      </Button>
      {updateStatus && <p role="status">{updateStatus}</p>}
    </section>}
  </section>;
}
