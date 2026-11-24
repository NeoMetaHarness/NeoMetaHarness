/**
 * Install Hermes on demand (P7-16). Installed apps ship without the Hermes source or a Python environment; the
 * user starts the install from Extensions or onboarding. The job downloads the pinned Hermes source into the app
 * data folder (verified against upstream.lock.json by the shared engine-source installer), prepares its venv with
 * uv, then asks the kernel to reactivate engine-hermes (and channels, which depends on it).
 */
import { EngineInstallError, installEngineSource, type EngineProgress } from '@neometaharness/kernel';
import { hermesLayout, hermesPython, hermesSourceOptions, resolveHermesSource } from './runtime.js';

export type HermesInstallPhase = 'download' | 'verify' | 'extract' | 'python' | 'dependencies' | 'starting';
export interface HermesInstallStatus {
  state: 'not_installed' | 'installing' | 'ready' | 'failed';
  phase?: HermesInstallPhase;
  /** Overall progress 0..1, when known. */
  progress?: number;
  /** One plain-language line for the UI. */
  message: string;
  /** Plain-language reason, when state is failed. */
  error?: string;
}

export const READY: HermesInstallStatus = { state: 'ready', message: 'Hermes is installed.' };
const NOT_INSTALLED: HermesInstallStatus = { state: 'not_installed', message: 'Hermes is not installed yet.' };

const messages: Record<HermesInstallPhase, string> = {
  download: 'Downloading Hermes…',
  verify: 'Checking the download…',
  extract: 'Unpacking Hermes…',
  python: 'Setting up Python…',
  dependencies: 'Installing Hermes components…',
  starting: 'Starting Hermes…',
};

/** Plain language for the owner; the technical detail goes to the Gateway log. */
export function installFailure(error: unknown): string {
  if (error instanceof EngineInstallError) {
    switch (error.kind) {
      case 'network': return "Couldn't download Hermes. Check your internet connection and try again.";
      case 'verify': return "The Hermes download didn't match the version Neo expects, so it wasn't installed. Try again later.";
      case 'unsafe': return 'The Hermes download contained files Neo does not accept, so it was not installed.';
      case 'disk': return "Couldn't save Hermes on this computer. Check that there is free disk space and try again.";
      case 'config': return "This version of Neo can't install Hermes. Update Neo and try again.";
      case 'cancelled': return 'The install was cancelled.';
    }
  }
  const failure = error as NodeJS.ErrnoException & { path?: string; stderr?: string };
  if (failure?.code === 'ENOENT' && /(^|[\\/])uv(\.exe)?$/i.test(String(failure.path ?? ''))) {
    return "Neo's Python installer (uv) is missing. Reinstall Neo and try again.";
  }
  if (failure?.code === 'ENOSPC') return "Couldn't save Hermes on this computer. Check that there is free disk space and try again.";
  return "Couldn't set up Hermes's Python environment. Check your internet connection and try again.";
}

export class HermesInstaller {
  private status: HermesInstallStatus;
  private job?: Promise<void>;
  private readonly abort = new AbortController();

  constructor(private readonly options: {
    /** App-data engines folder; undefined when this Gateway has no data folder to install into. */
    enginesDir?: string;
    /** The Gateway's runtime root, which holds upstream.lock.json. */
    runtimeRoot?: string;
    /** Test fixture server; production downloads from GitHub. */
    downloadBase?: string;
    /** Called once Hermes is ready to run; the extension restarts itself (ctx.reactivate). */
    onInstalled: () => void;
    log?: (message: string, error: unknown) => void;
  }) {
    const source = resolveHermesSource(options.enginesDir, options.runtimeRoot);
    this.status = source
      ? { state: 'not_installed', message: 'Hermes needs to finish installing.' }
      : NOT_INSTALLED;
  }

  current(): HermesInstallStatus { return { ...this.status }; }

  /** Start the install unless one is running. Returns the status right after starting. */
  start(): HermesInstallStatus {
    if (this.abort.signal.aborted) return this.current();
    if (!this.job && this.status.state !== 'ready') {
      this.set({ state: 'installing', phase: 'download', progress: 0, message: messages.download });
      this.job = this.run().finally(() => { this.job = undefined; });
    }
    return this.current();
  }

  /** The extension is stopping: abort downloads and uv. Does not wait for the job. */
  cancel(): void { this.abort.abort(); }

  private set(status: HermesInstallStatus): void { this.status = status; }

  private phase(phase: HermesInstallPhase, progress?: number): void {
    this.set({ state: 'installing', phase, ...(progress === undefined ? {} : { progress: Math.max(0, Math.min(1, progress)) }), message: messages[phase] });
  }

  private async run(): Promise<void> {
    const { enginesDir } = this.options;
    const signal = this.abort.signal;
    try {
      if (!enginesDir) throw new EngineInstallError('config', 'No engines folder: the Gateway has no data directory');
      const source = await installEngineSource({
        ...hermesSourceOptions(enginesDir, this.options.runtimeRoot), enginesDir, signal,
        ...(this.options.downloadBase ? { downloadBase: this.options.downloadBase } : {}),
        onProgress: (progress: EngineProgress) => {
          // Download 0-60 %, check 60 %, unpack 60-80 %, Python 80-95 %.
          const share = progress.total ? progress.done / progress.total : undefined;
          if (progress.phase === 'download') this.phase('download', share === undefined ? undefined : share * 0.6);
          else if (progress.phase === 'verify') this.phase('verify', 0.6);
          else this.phase('extract', 0.6 + (share ?? 0) * 0.2);
        },
      });
      const layout = hermesLayout(source, enginesDir);
      await hermesPython(source.path, layout, { signal, step: (step) => this.phase(step, step === 'python' ? 0.82 : 0.88) });
      if (signal.aborted) return;
      this.phase('starting', 0.97);
      this.options.onInstalled();
    } catch (error) {
      if (signal.aborted) return; // the extension is stopping; its next activation reports the state again
      this.options.log?.('Hermes install failed', error);
      this.set({ state: 'failed', message: 'Hermes could not be installed.', error: installFailure(error) });
    }
  }
}
