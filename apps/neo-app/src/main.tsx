import '@neometaharness/ui/styles.css';
import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell, NeoTheme, SideNav, SideNavItem, SideNavSection } from '@neometaharness/ui/shell';
import './shell.css';

const Extensions = lazy(() => import('./pages/Extensions'));
const Inbox = lazy(() => import('./pages/Inbox'));
const Agents = lazy(() => import('./pages/Agents'));
const Skills = lazy(() => import('./pages/Skills'));
const Memory = lazy(() => import('./pages/Memory'));
const Computers = lazy(() => import('./pages/Computers'));
const Coding = lazy(() => import('./pages/Coding'));
const Models = lazy(() => import('./pages/Models'));
const Channels = lazy(() => import('./pages/Channels'));
const Routines = lazy(() => import('./pages/Routines'));
const Tasks = lazy(() => import('./pages/Tasks'));
const Settings = lazy(() => import('./pages/Settings'));
const Placeholder = lazy(() => import('./pages/Placeholder'));
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

function activePath() {
  const candidate = window.location.pathname;
  return candidate.startsWith('/settings/') || pages.some(({ path }) => path === candidate) ? candidate : '/extensions';
}

function NeoApp() {
  const [path, setPath] = useState(activePath);
  useEffect(() => {
    const onPop = () => setPath(activePath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = (destination: string) => {
    if (destination !== path) window.history.pushState({}, '', destination + window.location.search);
    setPath(destination);
  };
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
        <Suspense fallback={<p role="status">Loading {current.label}…</p>}>
          {path === '/inbox' ? <Inbox /> : path === '/extensions' ? <Extensions /> : path === '/agents' ? <Agents /> : path === '/skills' ? <Skills /> : path === '/memory' ? <Memory /> : path === '/computers' ? <Computers /> : path === '/coding' ? <Coding /> : path === '/routines' ? <Routines /> : path === '/tasks' ? <Tasks /> : path === '/settings/channels' ? <Channels /> : path === '/settings/models' ? <Models /> : path === '/settings' ? <Settings onOpen={navigate} /> : <Placeholder name={current.label} />}
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

createRoot(document.getElementById('root')!).render(<StrictMode><NeoApp /></StrictMode>);
