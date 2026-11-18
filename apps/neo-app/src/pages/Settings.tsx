import { Button } from '@neometaharness/ui';

export default function Settings({ onOpenChannels }: { onOpenChannels: () => void }) {
  return <section aria-label="Settings">
    <h1>Settings</h1>
    <h2>Channels</h2>
    <p>Manage messaging connections for your bots.</p>
    <Button label="Manage channels" data-testid="settings-channels-open" onClick={onOpenChannels}>
      Manage channels
    </Button>
  </section>;
}
