import '@neometaharness/ui/styles.css';
import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell, NeoTheme, SideNav, SideNavItem, SideNavSection } from '@neometaharness/ui/shell';
import { Button } from '@neometaharness/ui';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { gatewayToken, gatewayUrl } from './config';
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
const Placeholder = lazy(() => import('./pages/Placeholder'));
const Setup = lazy(() => import('./pages/Setup'));
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

function NeoApp() {
  const [path, setPath] = useState(activePath);
  const [shellError, setShellError] = useState('');
  const [setupIncomplete, setSetupIncomplete] = useState(false);
  useEffect(() => {
    const onPop = () => setPath(activePath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = (destination: string) => {
    if (destination !== path) window.history.pushState({}, '', destination + window.location.search);
    setPath(destination);
  };
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
  const current = pages.find((page) => page.path === (path.startsWith('/settings') ? '/settings' : path))
    ?? pages.find((page) => page.path === '/extensions')!;

  return <NeoTheme>
    <AppShell variant="section" contentPadding={0} sideNav={
      <SideNav header={<div className="neo-nav-heading"><strong>Neo</strong><span>Meta Harness</span></div>}>
        <SideNavSection title="Workspace">
          {pages.map((page) => <SideNavItem
            key={page.path}
            label={page.label}
            href={page.path + window.location.search}
            icon={page.icon}
            isSelected={path === page.path || (page.path === '/settings' && path.startsWith('/settings/'))}
            onClick={(event) => {
              if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              navigate(page.path);
            }}
          />)}
        </SideNavSection>
      </SideNav>
    }>
      <div className="neo-page">
        {shellError && <p role="alert">{shellError}</p>}
        {setupIncomplete && path !== '/onboarding' && <Suspense fallback={null}>
          <SetupReminder onResume={() => navigate('/onboarding')} />
        </Suspense>}
        <Suspense fallback={<p role="status">Loading {current.label}…</p>}>
          {path === '/inbox' ? <Inbox /> : path === '/extensions' ? <Extensions /> : path === '/agents' ? <Agents /> : path === '/skills' ? <Skills /> : path === '/memory' ? <Memory /> : path === '/computers' ? <Computers /> : path === '/coding' ? <Coding /> : path === '/routines' ? <Routines /> : path === '/tasks' ? <Tasks /> : path === '/onboarding' ? <Onboarding onOpen={navigate} onSkip={skipSetup} onCompleted={completeSetup} /> : path === '/settings/channels' ? <Channels /> : path === '/settings/models' ? <Models /> : path === '/settings/metrics' ? <Metrics /> : path === '/settings' ? <Settings onOpen={navigate} /> : <Placeholder name={current.label} />}
        </Suspense>
      </div>
    </AppShell>
  </NeoTheme>;
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
createRoot(document.getElementById('root')!).render(<StrictMode>
  {startQuery.has('setup') ? <NeoTheme><Suspense fallback={null}><Setup error={startQuery.get('error')} /></Suspense></NeoTheme> : <NeoApp />}
</StrictMode>);
