export interface UpdateInfo {
  available: boolean;
  version: string | null;
  status: string;
  checking: boolean;
  error: string | null;
}

let currentState: UpdateInfo = {
  available: false,
  version: null,
  status: '',
  checking: false,
  error: null,
};

const listeners = new Set<(state: UpdateInfo) => void>();

function notify() {
  for (const listener of listeners) {
    try {
      listener(currentState);
    } catch {
      // ignore
    }
  }
}

export function getUpdateState(): UpdateInfo {
  return currentState;
}

export function subscribeUpdateState(listener: (state: UpdateInfo) => void): () => void {
  listeners.add(listener);
  listener(currentState);
  return () => {
    listeners.delete(listener);
  };
}

export async function checkForUpdates(): Promise<string | null> {
  const native = (window as unknown as {
    __TAURI_INTERNALS__?: {
      invoke: (name: string, args?: Record<string, unknown>) => Promise<string | null>;
    };
  }).__TAURI_INTERNALS__;

  if (!native) return null;

  currentState = {
    ...currentState,
    checking: true,
    status: 'Checking for updates…',
    error: null,
  };
  notify();

  try {
    const version = await native.invoke('check_for_updates');
    if (version) {
      currentState = {
        available: true,
        version,
        status: `Update available: Version ${version} is available`,
        checking: false,
        error: null,
      };
    } else {
      currentState = {
        available: false,
        version: null,
        status: 'No newer version found',
        checking: false,
        error: null,
      };
    }
  } catch (error) {
    currentState = {
      ...currentState,
      checking: false,
      status: String(error),
      error: String(error),
    };
  }
  notify();
  return currentState.version;
}

export async function installUpdate(): Promise<void> {
  const native = (window as unknown as {
    __TAURI_INTERNALS__?: {
      invoke: (name: string, args?: Record<string, unknown>) => Promise<void>;
    };
  }).__TAURI_INTERNALS__;

  if (!native) return;

  currentState = {
    ...currentState,
    status: 'Installing update and restarting…',
  };
  notify();

  try {
    await native.invoke('install_update');
  } catch (error) {
    currentState = {
      ...currentState,
      status: `Installation failed: ${String(error)}`,
      error: String(error),
    };
    notify();
  }
}

/** The shell's cached result of its single startup check (read without a network request). */
interface StartupUpdateStatus {
  done: boolean;
  version: string | null;
  error: string | null;
  /** A manual check started first, so the shell did not keep this result as the install candidate. */
  superseded?: boolean;
}

let startupApplied = false;

function applyStartupStatus(status: StartupUpdateStatus | null | undefined) {
  // Apply once, and never over a manual check that is running, has finished, or superseded it in the shell.
  if (!status?.done || status.superseded || startupApplied || currentState.checking || currentState.status) return;
  startupApplied = true;
  if (status.version) {
    currentState = {
      available: true,
      version: status.version,
      status: `Update available: Version ${status.version} is available`,
      checking: false,
      error: null,
    };
  } else if (status.error) {
    currentState = { ...currentState, status: status.error, error: status.error };
  } else {
    currentState = { ...currentState, status: 'No newer version found' };
  }
  notify();
}

if (typeof window !== 'undefined') {
  // Listen first, then read the cache: whichever arrives first wins, and the event can never be lost
  // to the webview starting after the check finished.
  window.addEventListener('neo:startup-update', (event: Event) => {
    applyStartupStatus((event as CustomEvent<StartupUpdateStatus>).detail);
  });
  const native = (window as unknown as {
    __TAURI_INTERNALS__?: { invoke: (name: string) => Promise<StartupUpdateStatus> };
  }).__TAURI_INTERNALS__;
  if (native) {
    native.invoke('startup_update_status').then(applyStartupStatus, () => {});
  }
}
