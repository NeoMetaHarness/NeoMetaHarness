/**
 * Engine sources (P7-16). Engines run from their source repos at the ref pinned in upstream.lock.json, unmodified.
 * Two places hold such a source, checked in this order:
 *   1. development: NMH_UPSTREAM_CACHE, or the nearest `nmh-upstream-cache` folder above the repository;
 *   2. installed apps: `<enginesDir>/<name>@<ref>`, which installEngineSource fills from the GitHub tarball of the
 *      pinned ref. The download is checked against the lock (archive sha256, and the commit git records in the
 *      tarball), then extracted into a temp dir that gets a marker and is renamed into place, as the desktop shell
 *      does for its runtime archive. Entries that leave the folder, links and device files are refused.
 * Shared by every engine that needs a source checkout (Hermes, the super agent, T3).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

export interface EnginePin {
  name: string;
  kind: string;
  ref: string;
  upstream: string;
  /** Full commit SHA the ref points at; git writes it into the tarball's pax global header. */
  commit?: string;
  /** sha256 of the GitHub tarball for `ref` (codeload.github.com/<upstream>/tar.gz/<ref path>). */
  archive_sha256?: string;
}

export type EngineSourceOrigin = 'dev-cache' | 'app-data';
export interface EngineSource { path: string; origin: EngineSourceOrigin; pin: EnginePin }

export interface EngineSourceOptions {
  /** Key in upstream.lock.json `pins`, e.g. `hermes-agent`. */
  name: string;
  lockFile: string;
  /** Where the upward search for `nmh-upstream-cache` starts (the repository or unpacked runtime root). */
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
  fetch?: typeof fetch;
}

export type EngineInstallErrorKind = 'network' | 'verify' | 'unsafe' | 'disk' | 'cancelled' | 'config';
export class EngineInstallError extends Error {
  constructor(readonly kind: EngineInstallErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EngineInstallError';
  }
}

const MARKER = '.neo-engine.json';

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

function devCacheRoot(options: EngineSourceOptions): string | undefined {
  const configured = options.upstreamCache ?? process.env.NMH_UPSTREAM_CACHE;
  if (configured) return configured;
  for (let dir = resolve(options.searchFrom); ; dir = dirname(dir)) {
    const candidate = join(dir, 'nmh-upstream-cache');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return undefined;
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
  const ref = pin.kind === 'release' ? `refs/tags/${pin.ref}` : (pin.commit ?? pin.ref);
  return new URL(`${root.pathname.replace(/\/$/, '')}/${pin.upstream}/tar.gz/${ref}`, root);
}

const running = new Map<string, Promise<EngineSource>>();

/** Install the pinned source into the app-data folder (no-op when it is already there). One install per target. */
export function installEngineSource(options: EngineInstallOptions): Promise<EngineSource> {
  const existing = resolveEngineSource(options);
  if (existing) return Promise.resolve(existing);
  const target = resolve(options.enginesDir, engineFolder(readEnginePin(options.lockFile, options.name)));
  let work = running.get(target);
  if (!work) {
    work = install(options, target).finally(() => running.delete(target));
    running.set(target, work);
  }
  return work;
}

async function install(options: EngineInstallOptions, target: string): Promise<EngineSource> {
  const pin = readEnginePin(options.lockFile, options.name);
  if (!pin.commit || !/^[a-f0-9]{40}$/.test(pin.commit) || !pin.archive_sha256 || !/^[a-f0-9]{64}$/.test(pin.archive_sha256)) {
    throw new EngineInstallError('config', `upstream.lock.json has no verified download for ${pin.name} (commit and archive_sha256)`);
  }
  const url = engineDownloadUrl(pin, options.downloadBase);
  const enginesDir = resolve(options.enginesDir);
  const temp = join(enginesDir, `.tmp-${pin.name}-${randomBytes(6).toString('hex')}`);
  const download = `${temp}.tar.gz`;
  const signal = options.signal;
  const cancelled = () => new EngineInstallError('cancelled', 'Install cancelled');
  try {
    try { await mkdir(temp, { recursive: true }); }
    catch (error) { throw new EngineInstallError('disk', `Cannot create ${temp}: ${(error as Error).message}`, { cause: error }); }

    // 1. Download, hashing as it streams to disk.
    let response: Response;
    try { response = await (options.fetch ?? fetch)(url, { signal, redirect: 'follow' }); }
    catch (error) {
      if (signal?.aborted) throw cancelled();
      throw new EngineInstallError('network', `Download of ${url.href} failed: ${(error as Error).message}`, { cause: error });
    }
    if (!response.ok || !response.body) throw new EngineInstallError('network', `Download of ${url.href} returned HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || undefined;
    const hash = createHash('sha256');
    let received = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk); received += chunk.length;
        options.onProgress?.({ phase: 'download', done: received, total });
        done(null, chunk);
      },
    });
    try { await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), meter, createWriteStream(download), { signal }); }
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
        await rm(target, { recursive: true, force: true });
      }
      await rename(temp, target);
    } catch (error) {
      if (markerMatches(target, pin)) return { path: target, origin: 'app-data', pin }; // another process won the rename
      throw new EngineInstallError('disk', `Cannot move ${pin.name} into ${target}: ${(error as Error).message}`, { cause: error });
    }
    return { path: target, origin: 'app-data', pin };
  } finally {
    await rm(download, { force: true }).catch(() => {});
    await rm(temp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
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
