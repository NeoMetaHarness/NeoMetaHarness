import { Banner, Collapsible, Heading, ProgressBar, Text } from '@neometaharness/ui';

/**
 * Shown by the desktop shell (`index.html?setup=1`) while it unpacks the bundled runtime on first launch and after
 * an update. Makes no Gateway calls: the shell navigates this window to the app once the Gateway is ready, or
 * reloads it with `&error=` when setup failed.
 */
export default function Setup({ error }: { error: string | null }) {
  return <main className="neo-setup" data-testid="desktop-setup">
    <Heading level={1}>Neo Meta Harness</Heading>
    {error
      ? <Banner status="error" title="Neo could not start" description={<>
        <Text as="p">Close this window and start Neo again. If it keeps failing, reinstall Neo.</Text>
      </>} />
      : null}
    {error ? <Collapsible trigger="Technical details"><pre className="neo-setup-error">{error}</pre></Collapsible>
      : <>
        <Text as="p">Setting up Neo… this happens once after install or update.</Text>
        <ProgressBar label="Setting up Neo" isIndeterminate />
      </>}
  </main>;
}
