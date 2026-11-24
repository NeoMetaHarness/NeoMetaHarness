/**
 * Engine sources (P7-16). Engines run from their source repos at the ref pinned in upstream.lock.json, unmodified.
 * Two places hold such a source, checked in this order:
 *   1. development: NMH_UPSTREAM_CACHE, or an `nmh-upstream-cache` folder inside a development checkout (the
 *      search stops at the repository root, so an installed runtime never picks up a folder planted above it);
 *   2. installed apps: `<enginesDir>/<name>@<ref>`, which installEngineSource fills from the GitHub tarball of the
 *      pinned commit. The download is checked against the lock (archive sha256, and the commit git records in the
 *      tarball), then extracted into a temp dir that gets a marker and is renamed into place, as the desktop shell
 *      does for its runtime archive. Entries that leave the folder, links and device files are refused.
 * Shared by every engine that needs a source checkout (Hermes, the super agent, T3).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

export interface EnginePin {
  name: string;
  kind: string;
  ref: string;
  upstream: string;
  /** Full commit SHA the ref points at; git writes it into the tarball's pax global header. */
  commit?: string;
  /** sha256 of the GitHub tarball of `commit` (codeload.github.com/<upstream>/tar.gz/<commit>). */
  archive_sha256?: string;
}

export type EngineSourceOrigin = 'dev-cache' | 'app-data';
export interface EngineSource { path: string; origin: EngineSourceOrigin; pin: EnginePin }

export interface EngineSourceOptions {
  /** Key in upstream.lock.json `pins`, e.g. `hermes-agent`. */
  name: string;
  lockFile: string;
  /**
   * Where the search for `nmh-upstream-cache` starts. It only runs inside a development checkout: from here up to
   * the repository root (the first folder with `.git` or `pnpm-workspace.yaml`), never above it. An unpacked
   * installer runtime has neither, so it uses the development cache only when one is named explicitly.
   */
  searchFrom: string;
  /** App-data engines folder; without it only the development cache is used. */
  enginesDir?: string;
  /** A file, relative to the source root, that proves the checkout is the engine (e.g. its entry module). */
  probe: string;
  /** Development cache override; defaults to process.env.NMH_UPSTREAM_CACHE. */
  upstreamCache?: string;
}

export type EngineProgress = { phase: 'download' | 'verify' | 'extract'; done: number; total?: number };

export interface EngineInstallOptions extends EngineSourceOptions {
  enginesDir: string;
  /** Defaults to https://codeload.github.com. Plain http is accepted for loopback test fixtures only. */
  downloadBase?: string;
  onProgress?: (progress: EngineProgress) => void;
  signal?: AbortSignal;
  /** Proxy settings (HTTPS_PROXY, HTTP_PROXY, NO_PROXY); defaults to process.env. */
  proxyEnv?: NodeJS.ProcessEnv;
}

export type EngineInstallErrorKind = 'network' | 'verify' | 'unsafe' | 'disk' | 'cancelled' | 'config';
export class EngineInstallError extends Error {
  constructor(readonly kind: EngineInstallErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EngineInstallError';
  }
}

const MARKER = '.neo-engine.json';

/**
 * upstream.lock.json of the repository or unpacked runtime the Gateway serves (the injected runtimeRoot),
 * else of `fallbackRoot` (an extension's own source tree). An upgraded generation is copied into extension
 * storage, so only runtimeRoot finds the lock there. Isolated tests (NODE_ENV=test) may point at a fixture lock
 * whose pin matches a local fixture tarball; production always verifies against the shipped lock.
 */
export function upstreamLockFile(runtimeRoot: string | undefined, fallbackRoot: string): string {
  const fixture = process.env.NODE_ENV === 'test' ? process.env.NMH_TEST_UPSTREAM_LOCK : undefined;
  return fixture || join(runtimeRoot ?? fallbackRoot, 'upstream.lock.json');
}

export function readEnginePin(lockFile: string, name: string): EnginePin {
  const lock = JSON.parse(readFileSync(lockFile, 'utf8').replace(/^﻿/, '')) as { pins?: Record<string, Omit<EnginePin, 'name'>> };
  const pin = lock.pins?.[name];
  if (!pin || typeof pin.ref !== 'string' || typeof pin.upstream !== 'string') throw new Error(`No pin for ${name} in ${lockFile}`);
  if (!/^[A-Za-z0-9._-]+$/.test(pin.ref) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pin.upstream)) {
    throw new Error(`Invalid pin for ${name} in ${lockFile}`);
  }
  return { name, ...pin };
}

/** `<name>@<ref>`: the folder name the development cache and the app-data folder share. */
export function engineFolder(pin: EnginePin): string { return `${pin.name}@${pin.ref}`; }

/** The development checkout containing `from`: the nearest folder with `.git` or `pnpm-workspace.yaml`. */
export function repositoryRoot(from: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

function devCacheRoot(options: EngineSourceOptions): string | undefined {
  const configured = options.upstreamCache ?? process.env.NMH_UPSTREAM_CACHE;
  if (configured) return configured;
  const root = repositoryRoot(options.searchFrom);
  if (!root) return undefined; // installed runtime: no implicit development cache
  for (let dir = resolve(options.searchFrom); ; dir = dirname(dir)) {
    const candidate = join(dir, 'nmh-upstream-cache');
    if (existsSync(candidate)) return candidate;
    if (dir === root || dirname(dir) === dir) return undefined;
  }
}

function markerMatches(directory: string, pin: EnginePin): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(directory, MARKER), 'utf8')) as Record<string, unknown>;
    return marker.name === pin.name && marker.ref === pin.ref && marker.commit === pin.commit
      && marker.archive_sha256 === pin.archive_sha256;
  } catch { return false; }
}

/** The pinned source to run, or undefined when it is neither in the development cache nor installed. */
export function resolveEngineSource(options: EngineSourceOptions): EngineSource | undefined {
  const pin = readEnginePin(options.lockFile, options.name);
  const cache = devCacheRoot(options);
  if (cache) {
    const path = join(cache, engineFolder(pin));
    if (existsSync(join(path, options.probe))) return { path, origin: 'dev-cache', pin };
  }
  if (options.enginesDir) {
    const path = join(options.enginesDir, engineFolder(pin));
    if (markerMatches(path, pin) && existsSync(join(path, options.probe))) return { path, origin: 'app-data', pin };
  }
  return undefined;
}

export function engineDownloadUrl(pin: EnginePin, base = 'https://codeload.github.com'): URL {
  const root = new URL(base);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(root.hostname);
  if (root.protocol !== 'https:' && !(root.protocol === 'http:' && loopback)) {
    throw new EngineInstallError('config', `Engine downloads use HTTPS (${root.origin})`);
  }
  // The commit, not the tag: a tag moved upstream must neither change nor break what Neo installs.
  if (!pin.commit) throw new EngineInstallError('config', `upstream.lock.json pins no commit for ${pin.name}`);
  return new URL(`${root.pathname.replace(/\/$/, '')}/${pin.upstream}/tar.gz/${pin.commit}`, root);
}

const running = new Map<string, Promise<EngineSource>>();

/** Install the pinned source into the app-data folder (no-op when it is already there). One install per target. */
export function installEngineSource(options: EngineInstallOptions): Promise<EngineSource> {
  const existing = resolveEngineSource(options);
  if (existing) return Promise.resolve(existing);
  const target = resolve(options.enginesDir, engineFolder(readEnginePin(options.lockFile, options.name)));
  const shared = running.get(target);
  if (shared) {
    // The running install belongs to another caller; if that caller cancelled it, this one starts its own.
    return shared.catch((error: unknown) => {
      if (error instanceof EngineInstallError && error.kind === 'cancelled' && !options.signal?.aborted) return installEngineSource(options);
      throw error;
    });
  }
  const work = install(options, target).finally(() => running.delete(target));
  running.set(target, work);
  return work;
}

const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
/** Windows: antivirus and the indexer hold fresh files open for a while. Retry for up to ~30 s. */
export async function retrying<T>(work: () => Promise<T>, signal?: AbortSignal, budgetMs = 30_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (let delay = 100; ; delay = Math.min(delay * 2, 2000)) {
    try { return await work(); }
    catch (error) {
      if (!BUSY.has((error as NodeJS.ErrnoException).code ?? '') || Date.now() + delay > deadline || signal?.aborted) throw error;
      await new Promise((done) => setTimeout(done, delay));
    }
  }
}

/** GET with the proxy settings (HTTPS_PROXY, HTTP_PROXY, NO_PROXY) applied; redirects stay on HTTPS. */
export async function downloadEngineArchive(url: URL, signal: AbortSignal | undefined, proxyEnv = process.env, redirects = 5): Promise<IncomingMessage> {
  const client = url.protocol === 'https:' ? https : http;
  // Node 22.21+ applies HTTP(S)_PROXY / NO_PROXY for an agent given proxyEnv; older Nodes ignore the option.
  const agent = new client.Agent({ proxyEnv } as http.AgentOptions);
  const response = await new Promise<IncomingMessage>((done, fail) => {
    const request = client.get(url, { agent, ...(signal ? { signal } : {}) }, done);
    request.on('error', fail);
  });
  const location = response.headers.location;
  if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
    response.resume();
    const next = new URL(location, url);
    if (redirects <= 0 || (next.protocol !== 'https:' && next.origin !== url.origin)) {
      throw new EngineInstallError('network', `Refused redirect of ${url.href} to ${next.href}`);
    }
    return downloadEngineArchive(next, signal, proxyEnv, redirects - 1);
  }
  return response;
}

/** Remove what an interrupted earlier install left behind (`.tmp-<name>-*` folders and tarballs). */
async function removeLeftovers(enginesDir: string, name: string): Promise<void> {
  const prefix = `.tmp-${name}-`;
  for (const entry of await readdir(enginesDir).catch(() => [] as string[])) {
    if (entry.startsWith(prefix)) await retrying(() => rm(join(enginesDir, entry), { recursive: true, force: true })).catch(() => {});
  }
}

async function install(options: EngineInstallOptions, target: string): Promise<EngineSource> {
  const pin = readEnginePin(options.lockFile, options.name);
  if (!pin.commit || !/^[a-f0-9]{40}$/.test(pin.commit) || !pin.archive_sha256 || !/^[a-f0-9]{64}$/.test(pin.archive_sha256)) {
    throw new EngineInstallError('config', `upstream.lock.json has no verified download for ${pin.name} (commit and archive_sha256)`);
  }
  const url = engineDownloadUrl(pin, options.downloadBase);
  const enginesDir = resolve(options.enginesDir);
  await removeLeftovers(enginesDir, pin.name);
  const temp = join(enginesDir, `.tmp-${pin.name}-${randomBytes(6).toString('hex')}`);
  const download = `${temp}.tar.gz`;
  const signal = options.signal;
  const cancelled = () => new EngineInstallError('cancelled', 'Install cancelled');
  try {
    try { await mkdir(temp, { recursive: true }); }
    catch (error) { throw new EngineInstallError('disk', `Cannot create ${temp}: ${(error as Error).message}`, { cause: error }); }

    // 1. Download, hashing as it streams to disk.
    let response: IncomingMessage;
    try { response = await downloadEngineArchive(url, signal, options.proxyEnv ?? process.env); }
    catch (error) {
      if (signal?.aborted) throw cancelled();
      if (error instanceof EngineInstallError) throw error;
      throw new EngineInstallError('network', `Download of ${url.href} failed: ${(error as Error).message}`, { cause: error });
    }
    if (response.statusCode !== 200) {
      response.resume();
      throw new EngineInstallError('network', `Download of ${url.href} returned HTTP ${response.statusCode}`);
    }
    const total = Number(response.headers['content-length']) || undefined;
    const hash = createHash('sha256');
    let received = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk); received += chunk.length;
        options.onProgress?.({ phase: 'download', done: received, total });
        done(null, chunk);
      },
    });
    try { await pipeline(response, meter, createWriteStream(download), { signal }); }
    catch (error) {
      if (signal?.aborted) throw cancelled();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM') throw new EngineInstallError('disk', `Cannot write ${download}: ${(error as Error).message}`, { cause: error });
      throw new EngineInstallError('network', `Download of ${url.href} was interrupted: ${(error as Error).message}`, { cause: error });
    }

    // 2. Verify against the lock before anything is unpacked.
    options.onProgress?.({ phase: 'verify', done: received, total: received });
    const digest = hash.digest('hex');
    if (digest !== pin.archive_sha256) {
      throw new EngineInstallError('verify', `${pin.name}@${pin.ref} download has sha256 ${digest}, upstream.lock.json expects ${pin.archive_sha256}`);
    }

    // 3. Extract into the temp dir, then check the commit git recorded in the tarball.
    const size = statSync(download).size;
    let read = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        read += chunk.length;
        options.onProgress?.({ phase: 'extract', done: read, total: size });
        done(null, chunk);
      },
    });
    const extractor = new TarExtractor(temp);
    try {
      await pipeline(createReadStream(download), counter, createGunzip(), extractor.sink(), { signal });
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      if (error instanceof EngineInstallError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM') throw new EngineInstallError('disk', `Cannot extract into ${temp}: ${(error as Error).message}`, { cause: error });
      throw new EngineInstallError('verify', `${pin.name}@${pin.ref} download is not a valid tarball: ${(error as Error).message}`, { cause: error });
    }
    if (extractor.commit !== pin.commit) {
      throw new EngineInstallError('verify', `${pin.name}@${pin.ref} tarball is commit ${extractor.commit ?? 'unknown'}, upstream.lock.json expects ${pin.commit}`);
    }
    if (!existsSync(join(temp, options.probe))) {
      throw new EngineInstallError('verify', `${pin.name}@${pin.ref} tarball has no ${options.probe}`);
    }

    // 4. Marker, then one rename publishes the folder. A leftover target without a valid marker is replaced.
    try {
      await writeFile(join(temp, MARKER), JSON.stringify({ name: pin.name, ref: pin.ref, commit: pin.commit,
        archive_sha256: pin.archive_sha256, installed_at: new Date().toISOString() }, null, 2) + '\n');
      if (existsSync(target)) {
        if (markerMatches(target, pin) && existsSync(join(target, options.probe))) return { path: target, origin: 'app-data', pin };
        await retrying(() => rm(target, { recursive: true, force: true }), signal);
      }
      await retrying(() => rename(temp, target), signal);
    } catch (error) {
      if (markerMatches(target, pin)) return { path: target, origin: 'app-data', pin }; // another process won the rename
      throw new EngineInstallError('disk', `Cannot move ${pin.name} into ${target}: ${(error as Error).message}`, { cause: error });
    }
    return { path: target, origin: 'app-data', pin };
  } finally {
    await retrying(() => rm(download, { force: true })).catch(() => {});
    await retrying(() => rm(temp, { recursive: true, force: true })).catch(() => {});
  }
}

/** Safe relative path inside the extraction root with the tarball's single top-level folder removed. */
export function safeEntryPath(raw: string): string | undefined {
  if (raw.includes('\0')) throw new EngineInstallError('unsafe', `Archive entry has a NUL byte: ${JSON.stringify(raw)}`);
  const normalized = raw.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || isAbsolute(normalized)) {
    throw new EngineInstallError('unsafe', `Archive entry is absolute: ${raw}`);
  }
  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..' || part.includes(':'))) throw new EngineInstallError('unsafe', `Archive entry leaves the folder: ${raw}`);
  if (parts.length <= 1) return undefined; // the top-level folder itself
  return parts.slice(1).join('/');
}

/**
 * A streaming tar reader for GitHub tarballs (ustar with pax headers). Only regular files and directories are
 * written; links, devices and FIFOs are refused, so nothing can point outside the extraction root.
 */
class TarExtractor {
  commit?: string;
  private pending: Buffer[] = [];
  private pendingLength = 0;
  private need = 512;
  private top?: string;
  private paxPath?: string;
  private longName?: string;
  private ended = false;
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  sink(): Transform {
    return new Transform({
      transform: (chunk: Buffer, _encoding, done) => { this.feed(chunk).then(() => done(), done); },
      flush: (done) => {
        if (!this.ended) done(new Error('tarball ended early')); else done();
      },
    });
  }

  /** Chunks are joined only once the next header plus its body is complete, so large files are copied once. */
  private async feed(chunk: Buffer): Promise<void> {
    if (this.ended) return;
    this.pending.push(chunk);
    this.pendingLength += chunk.length;
    if (this.pendingLength < this.need) return;
    let buffer = Buffer.concat(this.pending, this.pendingLength);
    this.pending = []; this.pendingLength = 0;
    for (;;) {
      if (this.ended) return;
      if (buffer.length < 512) { this.need = 512; break; }
      const header = buffer.subarray(0, 512);
      if (header.every((byte) => byte === 0)) { this.ended = true; return; }
      if (!checksumOk(header)) throw new EngineInstallError('verify', 'Tarball header checksum mismatch');
      const size = octal(header.subarray(124, 136));
      const padded = Math.ceil(size / 512) * 512;
      if (buffer.length < 512 + padded) { this.need = 512 + padded; break; }
      const body = buffer.subarray(512, 512 + size);
      buffer = buffer.subarray(512 + padded);
      await this.entry(header, body);
    }
    if (buffer.length) { this.pending = [buffer]; this.pendingLength = buffer.length; }
  }

  private async entry(header: Buffer, body: Buffer): Promise<void> {
    const type = String.fromCharCode(header[156] ?? 0);
    if (type === 'g') {
      const records = pax(body);
      if (records.comment && /^[a-f0-9]{40}$/.test(records.comment)) this.commit = records.comment;
      return;
    }
    if (type === 'x') { this.paxPath = pax(body).path; return; }
    if (type === 'L') { this.longName = body.toString('utf8').replace(/\0+$/, ''); return; }
    const ustar = header.subarray(257, 262).toString('latin1') === 'ustar';
    const prefix = ustar ? cstring(header.subarray(345, 500)) : '';
    const name = this.paxPath ?? this.longName ?? (prefix ? `${prefix}/${cstring(header.subarray(0, 100))}` : cstring(header.subarray(0, 100)));
    this.paxPath = undefined; this.longName = undefined;
    if (type !== '0' && type !== '\0' && type !== '5') {
      throw new EngineInstallError('unsafe', `Archive entry ${name} is a ${type === '2' ? 'symbolic link' : type === '1' ? 'hard link' : `type ${JSON.stringify(type)} entry`}; only files and folders are accepted`);
    }
    const first = name.replace(/\\/g, '/').split('/').find((part) => part && part !== '.');
    if (first) {
      this.top ??= first;
      if (first !== this.top) throw new EngineInstallError('unsafe', `Archive has more than one top-level folder (${this.top}, ${first})`);
    }
    const relative = safeEntryPath(name);
    if (!relative) return;
    const destination = resolve(this.root, ...relative.split('/'));
    if (!destination.startsWith(this.root + sep)) throw new EngineInstallError('unsafe', `Archive entry leaves the folder: ${name}`);
    if (type === '5') { await mkdir(destination, { recursive: true }); return; }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, body, { flag: 'wx' });
    const mode = octal(header.subarray(100, 108));
    if (process.platform !== 'win32' && mode & 0o111) await chmod(destination, 0o755);
  }
}

function cstring(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString('utf8');
}

function octal(bytes: Buffer): number {
  if ((bytes[0]! & 0x80) !== 0) { // base-256 (GNU) for very large sizes
    let value = 0;
    for (let index = 1; index < bytes.length; index++) value = value * 256 + bytes[index]!;
    return value;
  }
  const text = cstring(bytes).trim();
  return text ? parseInt(text, 8) : 0;
}

function checksumOk(header: Buffer): boolean {
  let sum = 0;
  for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index]!;
  return sum === octal(header.subarray(148, 156));
}

function pax(body: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) break;
    const length = parseInt(body.subarray(offset, space).toString('latin1'), 10);
    if (!Number.isSafeInteger(length) || length <= 0) break;
    const record = body.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

/** For tests and diagnostics: whether `<enginesDir>/<name>@<ref>` holds a verified install. */
export async function engineMarker(directory: string): Promise<Record<string, unknown> | undefined> {
  try { return JSON.parse(await readFile(join(directory, MARKER), 'utf8')) as Record<string, unknown>; }
  catch { return undefined; }
}
