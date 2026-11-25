import '@neometaharness/ui/styles.css';
import { StrictMode, Suspense, lazy, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell, SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@neometaharness/ui/shell';

import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { gatewayToken, gatewayUrl } from './config';
import { AppAppearance, useAppearance, type Appearance } from './appearance';
import './shell.css';

const Extensions = lazy(() => import('./pages/Extensions'));
const Inbox = lazy(() => import('./pages/Inbox'));
const Agents = lazy(() => import('./pages/Agents'));
const Skills = lazy(() => import('./pages/Skills'));
const Memory = lazy(() => import('./pages/Memory'));
const Computers = lazy(() => import('./pages/Computers'));
const Coding = lazy(() => import('./pages/Coding'));
const Models = lazy(() => import('./pages/Models'));
const Metrics = lazy(() => import('./pages/Metrics'));
const Channels = lazy(() => import('./pages/Channels'));
const Routines = lazy(() => import('./pages/Routines'));
const Tasks = lazy(() => import('./pages/Tasks'));
const Settings = lazy(() => import('./pages/Settings'));
const Onboarding = lazy(() => import('./pages/Onboarding'));
const SetupReminder = lazy(() => import('./pages/SetupReminder'));
const Setup = lazy(() => import('./pages/Setup'));
const ShellError = lazy(() => import('./pages/ShellFeedback').then((module) => ({ default: module.ShellError })));
const MissingPage = lazy(() => import('./pages/ShellFeedback').then((module) => ({ default: module.MissingPage })));
const DiscardSettings = lazy(() => import('./pages/ShellFeedback').then((module) => ({ default: module.DiscardSettings })));
const pages = [
  { label: 'Inbox', path: '/inbox', icon: 'inbox' },
  { label: 'Agents', path: '/agents', icon: 'person' },
  { label: 'Coding', path: '/coding', icon: 'code' },
  { label: 'Routines', path: '/routines', icon: 'calendar' },
  { label: 'Tasks', path: '/tasks', icon: 'list' },
  { label: 'Computers', path: '/computers', icon: 'desktop' },
  { label: 'Skills', path: '/skills', icon: 'star' },
  { label: 'Memory', path: '/memory', icon: 'book' },
  { label: 'Extensions', path: '/extensions', icon: 'extension' },
  { label: 'Settings', path: '/settings', icon: 'settings' },
] as const;

const gateway = createORPCClient<ContractRouterClient<typeof neoContract>>(new RPCLink({
  url: gatewayUrl(),
  headers: () => {
    const token = gatewayToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  },
}));

export function parseDeepLink(raw: string): { path: '/inbox' | '/coding'; id: string } | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'neo:' || !['inbox', 'coding'].includes(url.hostname)) return null;
    if (!/^\/[^/]+$/.test(url.pathname)) return null;
    const id = decodeURIComponent(url.pathname.slice(1));
    if (!id || id.includes('/') || id.length > 256) return null;
    return { path: url.hostname === 'inbox' ? '/inbox' : '/coding', id };
  } catch {
    return null;
  }
}

function activePath() {
  const candidate = window.location.pathname;
  return candidate === '/onboarding' || candidate.startsWith('/settings/') || pages.some(({ path }) => path === candidate) ? candidate : '/extensions';
}

function NeoApp({ appearance, saveAppearance }: { appearance: Appearance; saveAppearance: (value: string) => void }) {
  const [path, setPath] = useState(activePath);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const [shellError, setShellError] = useState('');
  const [setupIncomplete, setSetupIncomplete] = useState(false);
  useEffect(() => {
    const onPop = () => setPath(activePath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const commitNavigation = (destination: string) => {
    if (destination !== path) window.history.pushState({}, '', destination + window.location.search);
    setPath(destination);
    setMobileOpen(false);
  };
  const navigate = (destination: string) => {
    if (destination !== path && settingsDirty) {
      setMobileOpen(false);
      setPendingPath(destination);
      return;
    }
    commitNavigation(destination);
  };
  useEffect(() => {
    if (!settingsDirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [settingsDirty]);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (!inTauri && !query.has('onboarding') && window.location.pathname !== '/onboarding') return;
    void gateway.onboarding.get().then((status) => {
      setSetupIncomplete(!status.completed);
      if (!status.completed && !query.has('deep_link') && !sessionStorage.getItem('neo_onboarding_skipped')) {
        window.history.replaceState({}, '', '/onboarding' + window.location.search);
        setPath('/onboarding');
      }
    }).catch((error) => setShellError(`Cannot load onboarding: ${String(error)}`));
  }, []);
  const skipSetup = () => {
    sessionStorage.setItem('neo_onboarding_skipped', '1');
    navigate('/extensions');
  };
  const completeSetup = () => {
    sessionStorage.removeItem('neo_onboarding_skipped');
    setSetupIncomplete(false);
    navigate('/extensions');
  };
  useEffect(() => {
    const route = (raw: string) => {
      const target = parseDeepLink(raw);
      if (!target) return;
      const url = new URL(window.location.href);
      url.pathname = target.path;
      url.searchParams.delete('openInbox');
      url.searchParams.delete('openThread');
      url.searchParams.set(target.path === '/inbox' ? 'openInbox' : 'openThread', target.id);
      window.history.pushState({}, '', url.pathname + url.search);
      setPath(target.path);
      window.dispatchEvent(new CustomEvent('neo:record', { detail: target }));
    };
    const onLink = (event: Event) => route((event as CustomEvent<string>).detail);
    const onStop = () => {
      void gateway.computers.kill({ engaged: true }).catch((error) =>
        setShellError(`Cannot stop agents: ${String(error)}`));
    };
    window.addEventListener('neo:deep-link', onLink);
    window.addEventListener('neo:stop-all-agents', onStop);
    const startup = new URLSearchParams(window.location.search).get('deep_link');
    if (startup) route(startup);
    return () => {
      window.removeEventListener('neo:deep-link', onLink);
      window.removeEventListener('neo:stop-all-agents', onStop);
    };
  }, []);
  const onboarding = path === '/onboarding';
  const nestedLabels: Record<string, string> = {
    '/settings/channels': 'Channels', '/settings/models': 'Models', '/settings/metrics': 'Success metrics',
  };
  const currentLabel = onboarding ? 'Workspace setup' : nestedLabels[path]
    ?? pages.find((page) => page.path === path)?.label ?? 'Page not found';
  const groups = [
    { title: 'Work', items: pages.slice(0, 5) },
    { title: 'Resources', items: pages.slice(5, 8) },
    { title: 'Administration', items: pages.slice(8) },
  ];

  useEffect(() => {
    pageRef.current?.focus();
  }, [path]);

  return <AppShell variant="section" contentPadding={0}
    mobileNav={onboarding ? false : { breakpoint: 'md', isOpen: mobileOpen, onOpenChange: setMobileOpen }}
    sideNav={onboarding ? undefined :
      <SideNav header={<SideNavHeading heading="Neo" subheading="Meta Harness" />}>
        {groups.map(({ title, items }) => <SideNavSection key={title} title={title}>
          {items.map((page) => <SideNavItem
            key={page.path}
            label={page.label}
            href={page.path + window.location.search}
            icon={page.icon}
            isSelected={path === page.path || (page.path === '/settings' && path.startsWith('/settings/'))}
            onClick={(event) => {
              if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
              event.preventDefault();
              navigate(page.path);
            }}
          />)}
        </SideNavSection>)}
      </SideNav>
    }>
      <div className="neo-page" ref={pageRef} tabIndex={-1} aria-label={currentLabel}>
        {shellError && <Suspense fallback={<span role="status">Loading error details…</span>}><ShellError message={shellError} /></Suspense>}
        {setupIncomplete && !onboarding && <Suspense fallback={<span role="status">Loading setup reminder…</span>}><SetupReminder onResume={() => navigate('/onboarding')} /></Suspense>}
        <Suspense fallback={<div className="neo-route-loading" role="status">{ `Loading ${currentLabel}…` }</div>}>
          {path === '/inbox' ? <Inbox /> : path === '/extensions' ? <Extensions /> : path === '/agents' ? <Agents /> : path === '/skills' ? <Skills /> : path === '/memory' ? <Memory /> : path === '/computers' ? <Computers /> : path === '/coding' ? <Coding /> : path === '/routines' ? <Routines /> : path === '/tasks' ? <Tasks /> : path === '/onboarding' ? <Onboarding onOpen={navigate} onSkip={skipSetup} onCompleted={completeSetup} onIncomplete={setSetupIncomplete} /> : path === '/settings/channels' ? <Channels /> : path === '/settings/models' ? <Models /> : path === '/settings/metrics' ? <Metrics /> : path === '/settings' ? <Settings onOpen={navigate} appearance={appearance} onAppearanceChange={saveAppearance} onDirtyChange={setSettingsDirty} /> : <MissingPage onBack={() => navigate('/settings')} />}
        </Suspense>
        {pendingPath !== null && <Suspense fallback={<span role="status">Loading confirmation…</span>}>
          <DiscardSettings onCancel={() => setPendingPath(null)} onDiscard={() => {
            commitNavigation(pendingPath);
            setPendingPath(null);
          }} />
        </Suspense>}
      </div>
    </AppShell>;
}

const inTauri = '__TAURI_INTERNALS__' in window;
if ('serviceWorker' in navigator) {
  if (inTauri) {
    void navigator.serviceWorker.getRegistrations().then((registrations) =>
      Promise.all(registrations.map((registration) => registration.unregister())));
  } else if (import.meta.env.PROD) {
    void navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

// The desktop shell shows the setup screen while it unpacks the runtime (P7-15); it never talks to the Gateway.
const startQuery = new URLSearchParams(window.location.search);
function Root() {
  const { appearance, mode, saveAppearance } = useAppearance();
  return <AppAppearance mode={mode}>
    {startQuery.has('setup')
      ? <Suspense fallback={<main className="neo-setup"><span role="status">Starting Neo…</span></main>}><Setup error={startQuery.get('error')} /></Suspense>
      : <NeoApp appearance={appearance} saveAppearance={saveAppearance} />}
  </AppAppearance>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
