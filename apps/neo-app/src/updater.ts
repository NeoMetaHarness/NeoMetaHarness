export interface UpdateInfo {
  available: boolean;
  version: string | null;
  status: string;
  checking: boolean;
  error: string | null;
}

/**
 * The shell's update state (Rust `UpdateCandidate`), the single source of truth. The frontend renders only
 * this, read through `update_state`. Never a command reply or an event payload.
 */
export interface UpdateSnapshot {
  generation: number;
  /** Bumped on every change in the shell; used to drop out-of-order `update_state` replies. */
  revision: number;
  available: boolean;
  version: string | null;
  checking: boolean;
  installing: boolean;
  error: string | null;
}

type Invoke = (name: string, args?: Record<string, unknown>) => Promise<unknown>;

const EMPTY: UpdateInfo = { available: false, version: null, status: '', checking: false, error: null };

/** What Settings shows for a snapshot. Pure. */
export function toUpdateInfo(snapshot: UpdateSnapshot): UpdateInfo {
  const available = snapshot.available && !!snapshot.version;
  let status = '';
  if (snapshot.installing) status = 'Installing update and restarting…';
  else if (snapshot.checking) status = 'Checking for updates…';
  else if (snapshot.error) status = snapshot.error;
  else if (available) status = `Update available: Version ${snapshot.version} is available`;
  else if (snapshot.generation > 0) status = 'No newer version found';
  return {
    available: available && !snapshot.installing,
    version: available ? snapshot.version : null,
    status,
    checking: snapshot.checking,
    error: snapshot.error,
  };
}

/**
 * An update store over the shell's state. Every reply, push event or load triggers `refresh()`, which reads
 * `update_state` and renders it, unless a newer revision was already rendered (out-of-order replies).
 */
export function createUpdateStore(invoke: Invoke | null) {
  let state: UpdateInfo = EMPTY;
  let revision = -1;
  /** The snapshot behind what is on screen; Install authorizes exactly its {generation, version}. */
  let rendered: UpdateSnapshot | null = null;
  const listeners = new Set<(state: UpdateInfo) => void>();

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        // ignore
      }
    }
  };

  const refresh = async (): Promise<void> => {
    if (!invoke) return;
    let snapshot: UpdateSnapshot;
    try {
      snapshot = (await invoke('update_state')) as UpdateSnapshot;
    } catch {
      return;
    }
    if (!snapshot || typeof snapshot.revision !== 'number' || snapshot.revision < revision) return;
    revision = snapshot.revision;
    rendered = snapshot;
    state = toUpdateInfo(snapshot);
    notify();
  };

  /** Run a command, then render whatever the shell state says (the reply itself is ignored). */
  const command = async (name: string, args?: Record<string, unknown>): Promise<void> => {
    if (!invoke) return;
    const running = args ? invoke(name, args) : invoke(name);
    void refresh(); // shows "checking"/"installing" once the shell has started
    try {
      await running;
    } catch {
      // Failures are recorded in the shell state.
    }
    await refresh();
  };

  return {
    get: (): UpdateInfo => state,
    subscribe(listener: (state: UpdateInfo) => void): () => void {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    check: () => command('check_for_updates'),
    /**
     * Install the candidate on screen. The shell refuses ("Update state changed, check again") if its
     * generation or version moved on since this was rendered.
     */
    install: async (): Promise<void> => {
      const shown = rendered;
      if (!state.available || !shown?.version) return;
      await command('install_update', { generation: shown.generation, version: shown.version });
    },
  };
}

function nativeInvoke(): Invoke | null {
  if (typeof window === 'undefined') return null;
  const native = (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__;
  return native ? (name, args) => native.invoke(name, args) : null;
}

const store = createUpdateStore(nativeInvoke());

export function getUpdateState(): UpdateInfo {
  return store.get();
}

export function subscribeUpdateState(listener: (state: UpdateInfo) => void): () => void {
  return store.subscribe(listener);
}

export async function checkForUpdates(): Promise<string | null> {
  await store.check();
  return store.get().version;
}

export async function installUpdate(): Promise<void> {
  await store.install();
}

if (typeof window !== 'undefined') {
  // The shell pushes a bare "changed" signal; the state always comes from update_state.
  window.addEventListener('neo:update-state', () => {
    void store.refresh();
  });
  void store.refresh();
}
