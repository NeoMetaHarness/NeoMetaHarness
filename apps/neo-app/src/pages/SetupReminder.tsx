import { Banner, Button } from '@neometaharness/ui';

export default function SetupReminder({ onResume }: { onResume: () => void }) {
  return <div className="neo-setup-reminder" data-testid="onboarding-reminder">
    <Banner status="info" title="Workspace setup is incomplete" description="Continue from your saved setup step when you are ready." endContent={<Button variant="secondary" label="Resume setup" onClick={onResume}>Resume setup</Button>} />
  </div>;
}
