import { Banner, Button } from '@neometaharness/ui';

export default function SetupReminder({ onResume }: { onResume: () => void }) {
  return <div className="neo-setup-reminder" data-testid="onboarding-reminder">
    <Banner status="info" title="Workspace setup is incomplete" description="Review your setup when you are ready." endContent={<Button label="Open setup" onClick={onResume}>Open setup</Button>} />
  </div>;
}
