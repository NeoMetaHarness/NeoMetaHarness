import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, lstatSync, readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { downloadEngineArchive, EngineInstallError, readEnginePin, retrying, safeEntryPath, upstreamLockFile } from '@neometaharness/kernel';

import { system32 } from './system-tools.js';

const exec = promisify(execFile);
/**
 * upstream.lock.json of the repository or unpacked runtime the Gateway serves (its runtimeRoot). Without one,
 * this source tree's own root; an upgraded generation is copied elsewhere and must be given the root.
 * Isolated tests (NODE_ENV=test) may point at a fixture lock.
 */
export function t3LockFile(runtimeRoot?: string): string {
  return upstreamLockFile(runtimeRoot, fileURLToPath(new URL('../../../', import.meta.url)));
}

type ReleasePin = { ref: string; commit?: string; cli_assets?: Record<string, string> };
function release(enginesDir: string, runtimeRoot?: string) {
  const pin = readEnginePin(t3LockFile(runtimeRoot), 't3code') as ReleasePin;
  const platform = `${process.platform}-${process.arch}`;
  const sha = pin.cli_assets?.[platform];
  if (!sha || !/^[a-f0-9]{64}$/.test(sha)) {
    throw new EngineInstallError('config', `T3 ${pin.ref} has no verified CLI for ${platform}`);
  }
  if (!/^v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pin.ref)) {
    throw new EngineInstallError('config', 'T3 has an invalid release version in the lock file.');
  }
  const base = `t3-${pin.ref.replace(/^v/, '')}-${platform}`;
  const archive = `${base}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const executable = process.platform === 'win32' ? 't3.exe' : 't3';
  return { pin, sha, base, archive, executable, target: join(enginesDir, `t3-cli@${pin.ref}-${platform}`) };
}

export function installedT3(enginesDir?: string, runtimeRoot?: string): string | undefined {
  if (!enginesDir) return undefined;
  try {
    const r = release(enginesDir, runtimeRoot);
    const executable = join(r.target, r.base, r.executable);
    const marker = JSON.parse(readFileSync(join(r.target, '.neo-t3-cli.json'), 'utf8')) as Record<string, string>;
    if (marker.ref === r.pin.ref && marker.commit === r.pin.commit && marker.sha256 === r.sha && lstatSync(executable).isFile()) return executable;
  } catch { /* absent or interrupted install */ }
  return undefined;
}

export type T3InstallPhase = 'download' | 'verify' | 'extract' | 'starting';
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
  return "Couldn't install T3. Try again, or check the Gateway logs for details.";
}

function assetUrl(pin: ReleasePin, archive: string): URL {
  const fixture = process.env.NODE_ENV === 'test' ? process.env.NMH_TEST_T3_ASSET_URL : undefined;
  const url = fixture ? new URL(fixture) : new URL(`https://github.com/pingdotgg/t3code/releases/download/${pin.ref}/${archive}`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new EngineInstallError('config', 'T3 release downloads require HTTPS');
  }
  return url;
}

export async function installT3Cli(
  enginesDir: string,
  runtimeRoot: string | undefined,
  signal: AbortSignal,
  phase: (step: Exclude<T3InstallPhase, 'starting'>, progress?: number) => void = () => {},
): Promise<void> {
  const r = release(enginesDir, runtimeRoot);
  if (installedT3(enginesDir, runtimeRoot)) return;
  await mkdir(enginesDir, { recursive: true });
  for (const entry of await readdir(enginesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.tmp-t3-cli-')) continue;
    const owner = /^\.tmp-t3-cli-(\d+)-/.exec(entry.name)?.[1];
    if (owner) {
      try { process.kill(Number(owner), 0); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
    }
    await retrying(() => rm(join(enginesDir, entry.name), { recursive: true, force: true }), signal).catch(() => {});
  }
  signal.throwIfAborted();
  const temp = await mkdtemp(join(enginesDir, `.tmp-t3-cli-${process.pid}-`));
  const archivePath = join(temp, r.archive);
  const extracted = join(temp, 'extracted');
  let stall: NodeJS.Timeout | undefined;
  try {
    // GNU tar accepts extra flags from the environment. Validate and extract with the same explicit options.
    const env = { ...process.env, TAR_OPTIONS: '', LC_ALL: 'C' };
    const tarPath = process.platform === 'win32' ? system32('tar.exe') : 'tar';
    const tar = (args: string[]) => exec(tarPath, args, { maxBuffer: 16 * 1024 * 1024, signal, env, windowsHide: true });
    await mkdir(extracted);
    const url = assetUrl(r.pin, r.archive);
    const stalled = new AbortController();
    stall = setTimeout(() => stalled.abort(), 60_000).unref();
    const downloadSignal = AbortSignal.any([signal, stalled.signal]);
    const response = await downloadEngineArchive(url, downloadSignal)
      .catch((error: unknown) => { throw new EngineInstallError('network', 'T3 release download failed', { cause: error }); });
    if (response.statusCode !== 200) {
      response.destroy();
      throw new EngineInstallError('network', 'T3 release download failed');
    }
    stall.refresh();
    const total = Number(response.headers['content-length']) || undefined;
    const hash = createHash('sha256');
    let received = 0;
    const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
      stall?.refresh();
      received += chunk.length;
      hash.update(chunk);
      phase('download', total ? Math.min(received / total, 1) * 0.90 : undefined);
      done(null, chunk);
    } });
    await pipeline(response, meter, createWriteStream(archivePath), { signal: downloadSignal }).catch((error: NodeJS.ErrnoException) => {
      const kind = ['ENOSPC', 'EACCES', 'EPERM'].includes(error.code ?? '') ? 'disk' : 'network';
      throw new EngineInstallError(kind, 'T3 archive download was interrupted', { cause: error });
    });
    clearTimeout(stall);
    phase('verify', 0.90);
    if (hash.digest('hex') !== r.sha) throw new EngineInstallError('verify', 'T3 CLI checksum mismatch');
    // Check both names and types before extraction. Reject links and special files even in a checksum-pinned archive.
    const [{ stdout }, { stdout: detailed }] = await Promise.all([
      tar(['-tf', archivePath]),
      tar(['-tvf', archivePath]),
    ]);
    const entries = stdout.split(/\r?\n/).filter(Boolean);
    const listing = detailed.split(/\r?\n/).filter(Boolean);
    if (!entries.length || entries.length !== listing.length) {
      throw new EngineInstallError('unsafe', 'T3 CLI archive has an invalid entry listing');
    }
    const seen = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      safeEntryPath(entry);
      const parts = entry.replace(/\/$/, '').split('/');
      if (parts[0] !== r.base || /[\\\x00-\x1f\x7f]/.test(entry)
        || parts.some((part) => !part || part === '.' || /[. ]$/.test(part)
          || /[<>:"|?*]/.test(part)
          || /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(part))) {
        throw new EngineInstallError('unsafe', 'T3 CLI archive contains an unsafe path');
      }
      const description = listing[index];
      if (!description.endsWith(' ' + entry) || !/^[d-]/.test(description)) {
        throw new EngineInstallError('unsafe', `T3 CLI archive contains a link or special file: ${entry}`);
      }
      const key = parts.join('/').toLowerCase();
      if (seen.has(key)) throw new EngineInstallError('unsafe', `T3 CLI archive contains a duplicate path: ${entry}`);
      seen.add(key);
    }
    phase('extract', 0.92);
    await tar(['--no-same-owner', '--no-same-permissions', '-xf', archivePath, '-C', extracted]);
    const binary = join(extracted, r.base, r.executable);
    if (!(await lstat(binary).catch(() => undefined))?.isFile()) throw new EngineInstallError('verify', `T3 CLI archive is missing ${r.executable}`);
    await writeFile(join(extracted, '.neo-t3-cli.json'), JSON.stringify({ ref: r.pin.ref, commit: r.pin.commit, sha256: r.sha }) + '\n');
    if (signal.aborted) throw new EngineInstallError('cancelled', 'T3 installation cancelled');
    if (existsSync(r.target)) await retrying(() => rm(r.target, { recursive: true, force: true }), signal);
    await retrying(() => rename(extracted, r.target), signal);
  } finally {
    clearTimeout(stall);
    await retrying(() => rm(temp, { recursive: true, force: true })).catch(() => {});
  }
}

export class T3Installer {
  private status: T3InstallStatus = { state: 'not_installed', message: "T3 isn't installed yet." };
  private job?: Promise<void>;
  private readonly abort = new AbortController();

  constructor(private readonly enginesDir: string | undefined, private readonly onInstalled: () => void,
    private readonly runtimeRoot?: string) {}
  current(): T3InstallStatus { return { ...this.status }; }
  async cancel(): Promise<void> { this.abort.abort(); await this.job; }
  start(): T3InstallStatus {
    if (this.abort.signal.aborted) return this.current();
    if (!this.job && this.status.state !== 'ready') {
      this.status = { state: 'installing', phase: 'download', progress: 0, message: 'Downloading T3…' };
      this.job = this.install().finally(() => { this.job = undefined; });
    }
    return this.current();
  }
  private phase(step: Exclude<T3InstallPhase, 'starting'>, progress?: number) {
    const message = { download: 'Downloading T3…', verify: 'Verifying T3…', extract: 'Unpacking T3…' };
    this.status = { state: 'installing', phase: step, message: message[step], ...(progress === undefined ? {} : { progress }) };
  }
  private async install() {
    try {
      if (!this.enginesDir) throw new EngineInstallError('config', 'Neo has no engine storage folder');
      await installT3Cli(this.enginesDir, this.runtimeRoot, this.abort.signal, (phase, progress) => this.phase(phase, progress));
      if (this.abort.signal.aborted) return;
      this.status = { state: 'ready', message: 'T3 is installed and ready to start.' };
      this.onInstalled();
    } catch (error) {
      if (this.abort.signal.aborted) return;
      console.error('T3 installation failed', error);
      this.status = { state: 'failed', message: 'T3 could not be installed.', error: t3InstallFailure(error) };
    }
  }
}
