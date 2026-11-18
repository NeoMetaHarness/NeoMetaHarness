import { Button } from '@neometaharness/ui';

export default function Settings({ onOpen }: { onOpen: (path: '/settings/channels' | '/settings/models') => void }) {
  return <section aria-label="Settings">
    <h1>Settings</h1>
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
  </section>;
}
