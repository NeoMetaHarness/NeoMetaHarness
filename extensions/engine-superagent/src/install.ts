/**
 * Install the super agent on demand (P7-16). Installed apps ship without the dsh-superagent source. The user starts
 * the install from Extensions; the job downloads the pinned source into the app data folder (verified against
 * upstream.lock.json by the shared engine-source installer), builds the bundle Neo runs from it, then asks the
 * kernel to reactivate engine-superagent.
 */
import { EngineInstallError, installEngineSource, type EngineProgress } from '@neometaharness/kernel';
import { ensureSuperagentBundle, superagentSourceOptions } from './pinned.js';

export type SuperagentInstallPhase = 'download' | 'verify' | 'extract' | 'build' | 'starting';
export interface SuperagentInstallStatus {
  state: 'not_installed' | 'installing' | 'ready' | 'failed';
  phase?: SuperagentInstallPhase;
  /** Overall progress 0..1, when known. */
  progress?: number;
  /** One plain-language line for the UI. */
  message: string;
  /** Plain-language reason, when state is failed. */
  error?: string;
}

export const READY: SuperagentInstallStatus = { state: 'ready', message: 'The super agent is installed.' };
const NOT_INSTALLED: SuperagentInstallStatus = { state: 'not_installed', message: 'The super agent is not installed yet.' };

const messages: Record<SuperagentInstallPhase, string> = {
  download: 'Downloading the super agent…',
  verify: 'Checking the download…',
  extract: 'Unpacking the super agent…',
  build: 'Preparing the super agent…',
  starting: 'Starting the super agent…',
};

/** Plain language for the owner; the technical detail goes to the Gateway log. */
export function installFailure(error: unknown): string {
  if (error instanceof EngineInstallError) {
    switch (error.kind) {
      case 'network': return "Couldn't download the super agent. Check your internet connection and try again.";
      case 'verify': return "The super agent download didn't match the version Neo expects, so it wasn't installed. Try again later.";
      case 'unsafe': return 'The super agent download contained files Neo does not accept, so it was not installed.';
      case 'disk': return "Couldn't save the super agent on this computer. Check that there is free disk space and try again.";
      case 'config': return "This version of Neo can't install the super agent. Update Neo and try again.";
      case 'cancelled': return 'The install was cancelled.';
    }
  }
  if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC') {
    return "Couldn't save the super agent on this computer. Check that there is free disk space and try again.";
  }
  // The build runs only on the verified source and Neo's own packages (esbuild). Security software holding or
  // quarantining esbuild is the usual cause, and often passes; a lasting failure means a damaged Neo install.
  return "Couldn't prepare the super agent. Try again; if it keeps failing, reinstall Neo.";
}

export class SuperagentInstaller {
  private status: SuperagentInstallStatus;
  private job?: Promise<void>;
  private readonly abort = new AbortController();

  constructor(private readonly options: {
    /** App-data engines folder; undefined when this Gateway has no data folder to install into. */
    enginesDir?: string;
    /** The Gateway's runtime root, which holds upstream.lock.json. */
    runtimeRoot?: string;
    /** Activation found the source but could not build its bundle: start as failed, so the UI can retry. */
    failure?: unknown;
    /** Test fixture server; production downloads from GitHub. */
    downloadBase?: string;
    /** Called once the super agent is ready to run; the extension restarts itself (ctx.reactivate). */
    onInstalled: () => void;
    log?: (message: string, error: unknown) => void;
  }) {
    this.status = 'failure' in options
      ? { state: 'failed', message: 'The super agent could not be prepared.', error: installFailure(options.failure) }
      : NOT_INSTALLED;
  }

  current(): SuperagentInstallStatus { return { ...this.status }; }

  /** Start the install unless one is running. Returns the status right after starting. */
  start(): SuperagentInstallStatus {
    if (this.abort.signal.aborted) return this.current();
    if (!this.job && this.status.state !== 'ready') {
      this.set({ state: 'installing', phase: 'download', progress: 0, message: messages.download });
      this.job = this.run().finally(() => { this.job = undefined; });
    }
    return this.current();
  }

  /** The extension is stopping: abort the download. Does not wait for the job. */
  cancel(): void { this.abort.abort(); }

  private set(status: SuperagentInstallStatus): void { this.status = status; }

  private phase(phase: SuperagentInstallPhase, progress?: number): void {
    this.set({ state: 'installing', phase, ...(progress === undefined ? {} : { progress: Math.max(0, Math.min(1, progress)) }), message: messages[phase] });
  }

  private async run(): Promise<void> {
    const { enginesDir } = this.options;
    const signal = this.abort.signal;
    try {
      if (!enginesDir) throw new EngineInstallError('config', 'No engines folder: the Gateway has no data directory');
      const source = await installEngineSource({
        ...superagentSourceOptions(enginesDir, this.options.runtimeRoot), enginesDir, signal,
        ...(this.options.downloadBase ? { downloadBase: this.options.downloadBase } : {}),
        onProgress: (progress: EngineProgress) => {
          // Download 0-70 %, check 70 %, unpack 70-90 %, build 90-97 %.
          const share = progress.total ? progress.done / progress.total : undefined;
          if (progress.phase === 'download') this.phase('download', share === undefined ? undefined : share * 0.7);
          else if (progress.phase === 'verify') this.phase('verify', 0.7);
          else this.phase('extract', 0.7 + (share ?? 0) * 0.2);
        },
      });
      if (signal.aborted) return;
      this.phase('build', 0.92);
      // The reactivation that follows finds this bundle current and reuses it.
      await ensureSuperagentBundle(source);
      if (signal.aborted) return;
      this.phase('starting', 0.97);
      this.options.onInstalled();
    } catch (error) {
      if (signal.aborted) return; // the extension is stopping; its next activation reports the state again
      this.options.log?.('Super agent install failed', error);
      this.set({ state: 'failed', message: 'The super agent could not be installed.', error: installFailure(error) });
    }
  }
}
