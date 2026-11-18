import { Button } from '@neometaharness/ui';

export default function SetupReminder({ onResume }: { onResume: () => void }) {
  return <div className="neo-setup-reminder" data-testid="onboarding-reminder">
    <span>Finish setting up your workspace when you are ready.</span>
    <Button label="Resume setup" onClick={onResume}>Resume setup</Button>
  </div>;
}
