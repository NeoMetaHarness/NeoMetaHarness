/** T3 v0.1.9 installs its pinned, unmodified source through the shared engine installer.
 * The official upstream CLI release supplies the prebuilt server and native dependencies.
 * Both archives must match checksums in upstream.lock.json before publication.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { EngineInstallError, installEngineSource, readEnginePin, retrying,
  type EngineProgress } from '@neometaharness/kernel';

const exec = promisify(execFile);
const repoDir = resolve(fileURLToPath(new URL('../', import.meta.url)), '../..');
const PROBE = 'apps/server/src/bin.ts';

export function t3SourceOptions(enginesDir?: string) {
  const fixture = process.env.NODE_ENV === 'test' ? process.env.NMH_TEST_UPSTREAM_LOCK : undefined;
  return { name: 't3code', lockFile: fixture ?? join(repoDir, 'upstream.lock.json'), searchFrom: repoDir,
    probe: PROBE, ...(enginesDir ? { enginesDir } : {}) };
}

type ReleasePin = { ref: string; commit?: string; cli_assets?: Record<string, string> };
function release(enginesDir: string) {
  const pin = readEnginePin(t3SourceOptions(enginesDir).lockFile, 't3code') as ReleasePin;
  const platform = `${process.platform}-${process.arch}`;
  const sha = pin.cli_assets?.[platform];
  if (!sha || !/^[a-f0-9]{64}$/.test(sha)) {
    throw new EngineInstallError('config', `T3 ${pin.ref} has no verified CLI for ${platform}`);
  }
  const base = `t3-${pin.ref.replace(/^v/, '')}-${platform}`;
  const archive = `${base}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const executable = process.platform === 'win32' ? 't3.exe' : 't3';
  return { pin, sha, base, archive, executable, target: join(enginesDir, `t3-cli@${pin.ref}-${platform}`) };
}

export function installedT3(enginesDir?: string): string | undefined {
  if (!enginesDir) return undefined;
  const r = release(enginesDir);
  const executable = join(r.target, r.base, r.executable);
  try {
    const marker = JSON.parse(readFileSync(join(r.target, '.neo-t3-cli.json'), 'utf8')) as Record<string, string>;
    if (marker.commit === r.pin.commit && marker.sha256 === r.sha && existsSync(executable)) return executable;
  } catch { /* absent or interrupted install */ }
  return undefined;
}

export type T3InstallPhase = 'download' | 'verify' | 'extract' | 'dependencies' | 'starting';
export interface T3InstallStatus {
  state: 'not_installed' | 'installing' | 'ready' | 'failed';
  phase?: T3InstallPhase;
  progress?: number;
  message: string;
  error?: string;
  connected?: boolean;
  external?: boolean;
}

export function t3InstallFailure(error: unknown): string {
  if (error instanceof EngineInstallError) {
    if (error.kind === 'config') return error.message;
    if (error.kind === 'network') return "Couldn't download T3. Check your connection and try again.";
    if (error.kind === 'disk') return "Couldn't save T3. Check available disk space and try again.";
    if (error.kind === 'unsafe' || error.kind === 'verify') return "T3's download failed verification. Please try again later.";
    if (error.kind === 'cancelled') return 'T3 installation was cancelled.';
  }
  return `Couldn't install T3. ${error instanceof Error ? error.message : String(error)}`;
}

function assetUrl(pin: ReleasePin, archive: string): URL {
  const fixture = process.env.NODE_ENV === 'test' ? process.env.NMH_TEST_T3_ASSET_URL : undefined;
  const url = fixture ? new URL(fixture) : new URL(`https://github.com/pingdotgg/t3code/releases/download/${pin.ref}/${archive}`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new EngineInstallError('config', 'T3 release downloads require HTTPS');
  }
  return url;
}

async function installCli(enginesDir: string, signal: AbortSignal, phase: (step: T3InstallPhase, progress?: number) => void): Promise<void> {
  const r = release(enginesDir);
  if (installedT3(enginesDir)) return;
  const temp = join(enginesDir, `.tmp-t3-cli-${randomBytes(6).toString('hex')}`);
  const archivePath = join(enginesDir, `${randomBytes(6).toString('hex')}.${r.archive.endsWith('.zip') ? 'zip' : 'tar.gz'}`);
  try {
    await mkdir(temp, { recursive: true });
    const response = await fetch(assetUrl(r.pin, r.archive), { signal });
    if (!response.ok || !response.body) throw new EngineInstallError('network', `T3 CLI download returned HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || undefined;
    const hash = createHash('sha256');
    let received = 0;
    const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      hash.update(chunk);
      phase('dependencies', total ? 0.65 + Math.min(received / total, 1) * 0.25 : undefined);
      done(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body as any), meter, createWriteStream(archivePath), { signal });
    phase('verify', 0.90);
    if (hash.digest('hex') !== r.sha) throw new EngineInstallError('verify', 'T3 CLI checksum mismatch');
    // The CLI archive is an official, checksum-pinned artifact. Reject paths escaping the extraction root.
    const { stdout } = await exec('tar', ['-tf', archivePath], { maxBuffer: 16 * 1024 * 1024, signal });
    for (const entry of stdout.split(/\r?\n/).filter(Boolean)) {
      const name = entry.replace(/\\/g, '/');
      if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some((part) => part === '..' || part.includes(':'))) {
        throw new EngineInstallError('unsafe', `T3 CLI archive contains an unsafe path: ${entry}`);
      }
    }
    phase('extract', 0.92);
    await exec('tar', ['-xf', archivePath, '-C', temp], { maxBuffer: 1024 * 1024, signal });
    const binary = join(temp, r.base, r.executable);
    if (!existsSync(binary)) throw new EngineInstallError('verify', `T3 CLI archive is missing ${r.executable}`);
    await writeFile(join(temp, '.neo-t3-cli.json'), JSON.stringify({ ref: r.pin.ref, commit: r.pin.commit, sha256: r.sha }) + '\n');
    if (signal.aborted) throw new EngineInstallError('cancelled', 'T3 installation cancelled');
    if (existsSync(r.target)) await retrying(() => rm(r.target, { recursive: true, force: true }), signal);
    await retrying(() => rename(temp, r.target), signal);
  } finally {
    await rm(archivePath, { force: true }).catch(() => {});
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

export class T3Installer {
  private status: T3InstallStatus = { state: 'not_installed', message: "T3 isn't installed yet." };
  private job?: Promise<void>;
  private readonly abort = new AbortController();

  constructor(private readonly enginesDir: string | undefined, private readonly onInstalled: () => void) {}
  current(): T3InstallStatus { return { ...this.status }; }
  cancel(): void { this.abort.abort(); }
  start(): T3InstallStatus {
    if (this.abort.signal.aborted) return this.current();
    if (!this.job && this.status.state !== 'ready') {
      this.status = { state: 'installing', phase: 'download', progress: 0, message: 'Downloading T3 source…' };
      this.job = this.install().finally(() => { this.job = undefined; });
    }
    return this.current();
  }
  private phase(step: T3InstallPhase, progress?: number) {
    const message: Record<T3InstallPhase, string> = { download: 'Downloading T3 source…', verify: 'Verifying T3…',
      extract: 'Unpacking T3…', dependencies: 'Downloading the ready-to-run T3 server…', starting: 'Starting T3…' };
    this.status = { state: 'installing', phase: step, message: message[step], ...(progress === undefined ? {} : { progress }) };
  }
  private async install() {
    try {
      if (!this.enginesDir) throw new EngineInstallError('config', 'Neo has no engine storage folder');
      await mkdir(this.enginesDir, { recursive: true });
      const options = t3SourceOptions(this.enginesDir);
      await installEngineSource({ ...options, enginesDir: this.enginesDir, signal: this.abort.signal,
        ...(process.env.NODE_ENV === 'test' && process.env.NMH_TEST_ENGINE_DOWNLOAD_BASE
          ? { downloadBase: process.env.NMH_TEST_ENGINE_DOWNLOAD_BASE } : {}),
        onProgress: (progress: EngineProgress) => {
          const fraction = progress.total ? Math.min(progress.done / progress.total, 1) : undefined;
          if (progress.phase === 'download') this.phase('download', fraction === undefined ? undefined : fraction * 0.45);
          else if (progress.phase === 'verify') this.phase('verify', 0.45);
          else this.phase('extract', fraction === undefined ? undefined : 0.45 + fraction * 0.18);
        },
      });
      this.phase('dependencies', 0.65);
      await installCli(this.enginesDir, this.abort.signal, (phase, progress) => this.phase(phase, progress));
      if (this.abort.signal.aborted) return;
      this.phase('starting', 0.99);
      this.status = { state: 'ready', message: 'T3 is installed and ready to start.' };
      this.onInstalled();
    } catch (error) {
      if (this.abort.signal.aborted) return;
      console.error('T3 installation failed', error);
      this.status = { state: 'failed', message: 'T3 could not be installed.', error: t3InstallFailure(error) };
    }
  }
}
