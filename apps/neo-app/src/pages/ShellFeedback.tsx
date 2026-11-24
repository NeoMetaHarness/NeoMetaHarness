import { AlertDialog, Banner, Button, EmptyState } from '@neometaharness/ui';

export function ShellError({ message }: { message: string }) {
  return <Banner status="error" title="Something went wrong" description={message} />;
}

export function MissingPage({ onBack }: { onBack: () => void }) {
  return <EmptyState title="Page not found" description="This settings page does not exist."
    actions={<Button label="Back to Settings" onClick={onBack} />} />;
}

export function DiscardSettings({ onCancel, onDiscard }: { onCancel: () => void; onDiscard: () => void }) {
  return <AlertDialog isOpen onOpenChange={(open) => { if (!open) onCancel(); }}
    title="Discard unsaved settings?" description="Changes you have not saved will be lost."
    cancelLabel="Keep editing" actionLabel="Discard changes" actionVariant="destructive"
    onAction={onDiscard} />;
}