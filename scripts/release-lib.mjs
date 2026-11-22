// Shared helpers for the local v1 release tooling (P7-11): release-manifest.mjs and release-preflight.mjs.
// Everything here is offline and read-only. No GitHub calls, no key files.
import { createHash, createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';

export const REPO = 'NeoMetaHarness/NeoMetaHarness';
export const UPDATER_ENDPOINT = `https://github.com/${REPO}/releases/latest/download/latest.json`;
export const PLACEHOLDER_PUBKEY = 'REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY';
export const releaseDownloadBase = (version) => `https://github.com/${REPO}/releases/download/v${version}`;
export const TAURI_CONFIG = 'apps/neo-app/src-tauri/tauri.conf.json';

/** Every file that carries the shipped app version. They must all agree. */
export const VERSION_FILES = [
  TAURI_CONFIG,
  'apps/neo-app/src-tauri/Cargo.toml',
  'apps/neo-app/src-tauri/Cargo.lock',
  'apps/neo-app/package.json',
];
const APP_CRATE = 'neo-meta-harness';

/** Full releases only: X.Y.Z with no pre-release or build suffix ("latest" skips pre-releases). */
export function assertReleaseVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Release version must be X.Y.Z without a pre-release suffix, got ${JSON.stringify(version)}`);
  }
  return version;
}

/** The version recorded in each VERSION_FILES entry (undefined when it cannot be found). */
export function readVersions(root) {
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const result = {};
  const attempt = (path, extract) => {
    try { result[path] = extract(read(path)); } catch { result[path] = undefined; }
  };
  attempt(VERSION_FILES[0], (text) => JSON.parse(text).version);
  attempt(VERSION_FILES[1], (text) => {
    const pkg = text.split(/^\[/m).find((section) => section.startsWith('package]'));
    return pkg?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  });
  attempt(VERSION_FILES[2], (text) => {
    const entry = text.split(/^\[\[package\]\]/m).find((block) => new RegExp(`^name = "${APP_CRATE}"$`, 'm').test(block));
    return entry?.match(/^version = "([^"]+)"/m)?.[1];
  });
  attempt(VERSION_FILES[3], (text) => JSON.parse(text).version);
  return result;
}

/** Problems with the version files, compared with `expected` (or with each other when omitted). */
export function versionProblems(versions, expected) {
  const problems = [];
  for (const path of VERSION_FILES) if (!versions[path]) problems.push(`${path}: no version found`);
  const found = [...new Set(Object.values(versions).filter(Boolean))];
  if (expected) {
    for (const [path, value] of Object.entries(versions)) {
      if (value && value !== expected) problems.push(`${path}: ${value} (expected ${expected})`);
    }
  } else if (found.length > 1) {
    problems.push(`versions disagree: ${Object.entries(versions).map(([p, v]) => `${p}=${v}`).join(', ')}`);
  }
  return problems;
}

/** The updater public key checked in to tauri.conf.json (not an override). Throws for the placeholder. */
export function checkedInPublicKey(root) {
  const pubkey = JSON.parse(readFileSync(join(root, TAURI_CONFIG), 'utf8')).plugins?.updater?.pubkey;
  try { decodePublicKey(pubkey); } catch (error) { throw new Error(`${TAURI_CONFIG}: ${error.message}`); }
  return pubkey.trim();
}

/** The CHANGELOG.md section body for `version` (`## [1.0.0] ...` or `## v1.0.0 ...`), or undefined. */
export function changelogSection(text, version) {
  const escaped = version.replace(/\./g, '\\.');
  const heading = new RegExp(`^## \\[?v?${escaped}\\]?(?=[\\s(—-]|$).*$`, 'm');
  const match = heading.exec(text);
  if (!match) return undefined;
  const rest = text.slice(match.index + match[0].length);
  const next = rest.search(/^## /m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/** Text that must never reach published release notes: minisign or PEM key material. */
const KEY_MATERIAL = /untrusted comment:|dW50cnVzdGVkIGNvbW1lbnQ6|-----BEGIN [A-Z ]*PRIVATE KEY-----|TAURI_SIGNING_PRIVATE_KEY/i;
export function assertNoKeyMaterial(text, label) {
  if (KEY_MATERIAL.test(text)) throw new Error(`${label} contains key material; refusing to publish it`);
  return text;
}

/** RFC 7386 JSON merge patch (how Tauri applies --config / TAURI_CONFIG overrides). */
export function mergePatch(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const result = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
function strictBase64(text, label) {
  if (!text || !STRICT_BASE64.test(text)) throw new Error(`${label} is not valid base64`);
  return Buffer.from(text, 'base64');
}
function minisignLines(encoded, label) {
  const outer = strictBase64(encoded.trim(), label);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(outer); }
  catch { throw new Error(`${label} does not decode to UTF-8 text`); }
  const body = text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split(/\r?\n/);
}

/**
 * A Tauri updater public key (base64 of a minisign public key file). Returns { keyId (hex), key (32 bytes) }.
 * Throws for the placeholder, an empty value or anything that is not an Ed25519 minisign key.
 */
export function decodePublicKey(encoded) {
  if (typeof encoded !== 'string' || !encoded.trim()) throw new Error('updater public key is empty');
  if (encoded.trim() === PLACEHOLDER_PUBKEY) throw new Error('updater public key is still the placeholder');
  const lines = minisignLines(encoded, 'updater public key');
  if (lines.length !== 2 || !lines[0].startsWith('untrusted comment:')) {
    throw new Error('updater public key must be a two-line minisign public key');
  }
  const key = strictBase64(lines[1].trim(), 'updater public key line 2');
  if (key.length !== 42 || key.subarray(0, 2).toString('latin1') !== 'Ed') {
    throw new Error('updater public key is not a 42-byte Ed25519 minisign key');
  }
  return { keyId: key.subarray(2, 10).toString('hex'), key: key.subarray(10) };
}

/** The 8-byte key id (hex) of a Tauri updater public key. See decodePublicKey. */
export function parsePublicKey(encoded) {
  return decodePublicKey(encoded).keyId;
}

const TRUSTED_PREFIX = 'trusted comment: ';

/**
 * A Tauri updater signature (the contents of a `.sig` file: base64 of a minisign signature file).
 * Returns { keyId, prehashed, signature, trustedComment, globalSignature }. Throws on anything malformed.
 */
export function parseSignature(encoded) {
  if (typeof encoded !== 'string' || !encoded.trim()) throw new Error('signature is empty');
  const lines = minisignLines(encoded, 'signature');
  if (lines.length !== 4 || !lines[0].startsWith('untrusted comment:') || !lines[2].startsWith(TRUSTED_PREFIX)) {
    throw new Error('signature must be a four-line minisign signature');
  }
  const signature = strictBase64(lines[1].trim(), 'signature line 2');
  const algorithm = signature.subarray(0, 2).toString('latin1');
  if (signature.length !== 74 || (algorithm !== 'Ed' && algorithm !== 'ED')) {
    throw new Error('signature is not a 74-byte Ed25519 minisign signature');
  }
  const globalSignature = strictBase64(lines[3].trim(), 'signature line 4');
  if (globalSignature.length !== 64) throw new Error('signature global signature must be 64 bytes');
  return {
    keyId: signature.subarray(2, 10).toString('hex'),
    prehashed: algorithm === 'ED',
    signature: signature.subarray(10),
    // Exactly what minisign covers with the global signature: the line after "trusted comment: ".
    trustedComment: lines[2].slice(TRUSTED_PREFIX.length),
    globalSignature,
  };
}

// DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 public key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Verify a Tauri `.sig` over `data` with the updater public key, as the Tauri updater does (minisign-verify):
 * key id match, Ed25519 over BLAKE2b-512(data) ("ED") or the raw bytes ("Ed"), then the global signature
 * over signature + trusted comment. Returns the parsed signature; throws when anything does not verify.
 */
export function verifyMinisign(publicKey, data, encodedSignature) {
  const { keyId, key } = decodePublicKey(publicKey);
  const parsed = parseSignature(encodedSignature);
  if (parsed.keyId !== keyId) throw new Error(`made with key ${parsed.keyId}, not the updater key ${keyId}`);
  const spki = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, key]), format: 'der', type: 'spki' });
  const signed = parsed.prehashed ? createHash('blake2b512').update(data).digest() : data;
  if (!verifyEd25519(null, signed, spki, parsed.signature)) throw new Error('signature does not match the file contents');
  const global = Buffer.concat([parsed.signature, Buffer.from(parsed.trustedComment, 'utf8')]);
  if (!verifyEd25519(null, global, spki, parsed.globalSignature)) throw new Error('trusted comment signature does not verify');
  return parsed;
}

const MAX_TAR_ENTRY = 1024 * 1024;
const cString = (bytes) => bytes.toString('utf8').replace(/\0.*$/s, '');
const octal = (bytes) => Number.parseInt(cString(bytes).trim() || '0', 8);
function tarSize(field) {
  if (field[0] & 0x80) { // GNU base-256
    let size = field[0] & 0x7f;
    for (const byte of field.subarray(1)) size = size * 256 + byte;
    return size;
  }
  return octal(field);
}

/**
 * Stream a .tar.gz and return the contents of the first regular file whose path satisfies `wanted`
 * (ustar prefixes, GNU long names and pax `path` records are honoured), or undefined. Never extracts to disk.
 */
export async function readTarGzEntry(file, wanted) {
  const stream = createReadStream(file).pipe(createGunzip());
  let buffer = Buffer.alloc(0);
  let skip = 0;
  let pending; // { type, size, padded }
  let longName;
  try {
    for await (const chunk of stream) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      for (;;) {
        if (skip > 0) {
          const n = Math.min(skip, buffer.length);
          buffer = buffer.subarray(n);
          skip -= n;
          if (skip > 0) break;
          continue;
        }
        if (pending) {
          if (buffer.length < pending.padded) break;
          const data = Buffer.from(buffer.subarray(0, pending.size));
          buffer = buffer.subarray(pending.padded);
          const { type } = pending;
          pending = undefined;
          if (type === 'L') longName = cString(data);
          else if (type === 'x') {
            const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1];
            if (path !== undefined) longName = path;
          } else return data;
          continue;
        }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512);
        buffer = buffer.subarray(512);
        if (header.every((byte) => byte === 0)) return undefined;
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
        if (sum !== octal(header.subarray(148, 156))) throw new Error('not a valid tar archive (header checksum)');
        const type = String.fromCharCode(header[156] || 48);
        const size = tarSize(header.subarray(124, 136));
        const padded = Math.ceil(size / 512) * 512;
        let name = cString(header.subarray(0, 100));
        // POSIX ustar ("ustar\0") has a name prefix; GNU ("ustar  ") keeps atime/ctime there instead.
        if (header.subarray(257, 263).toString('latin1') === 'ustar\0') {
          const prefix = cString(header.subarray(345, 500));
          if (prefix) name = `${prefix}/${name}`;
        }
        if (type === 'L' || type === 'x') {
          if (size > MAX_TAR_ENTRY) throw new Error('tar long-name record is too large');
          pending = { type, size, padded };
          continue;
        }
        if (longName !== undefined) { name = longName; longName = undefined; }
        if ((type === '0' || type === '7') && wanted(name)) {
          if (size > MAX_TAR_ENTRY) throw new Error(`${name} is too large to read`);
          pending = { type, size, padded };
        } else skip = padded;
      }
    }
  } finally { stream.destroy(); }
  return undefined;
}

/** CFBundleShortVersionString from an XML Info.plist, or undefined. */
export function plistShortVersion(text) {
  if (text.startsWith('bplist')) throw new Error('Info.plist is a binary plist; expected the XML plist Tauri writes');
  return /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([^<\s]+)\s*<\/string>/.exec(text)?.[1];
}
