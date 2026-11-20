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

if (typeof window !== 'undefined') {
  window.addEventListener('neo:update-available', (event: Event) => {
    const version = (event as CustomEvent<string>).detail;
    if (version) {
      currentState = {
        available: true,
        version,
        status: `Update available: Version ${version} is available`,
        checking: false,
        error: null,
      };
      notify();
    }
  });
}
