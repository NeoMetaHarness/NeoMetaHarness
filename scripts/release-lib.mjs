// Shared helpers for the local v1 release tooling (P7-11): release-manifest.mjs and release-preflight.mjs.
// Everything here is offline and read-only. No GitHub calls, no key files.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REPO = 'NeoMetaHarness/NeoMetaHarness';
export const UPDATER_ENDPOINT = `https://github.com/${REPO}/releases/latest/download/latest.json`;
export const PLACEHOLDER_PUBKEY = 'REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY';
export const releaseDownloadBase = (version) => `https://github.com/${REPO}/releases/download/v${version}`;

/** Every file that carries the shipped app version. They must all agree. */
export const VERSION_FILES = [
  'apps/neo-app/src-tauri/tauri.conf.json',
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
 * A Tauri updater public key (base64 of a minisign public key file). Returns its 8-byte key id (hex).
 * Throws for the placeholder, an empty value or anything that is not an Ed25519 minisign key.
 */
export function parsePublicKey(encoded) {
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
  return key.subarray(2, 10).toString('hex');
}

/**
 * A Tauri updater signature (the contents of a `.sig` file: base64 of a minisign signature file).
 * Returns { keyId, trustedComment }. Throws on anything malformed.
 */
export function parseSignature(encoded) {
  if (typeof encoded !== 'string' || !encoded.trim()) throw new Error('signature is empty');
  const lines = minisignLines(encoded, 'signature');
  if (lines.length !== 4 || !lines[0].startsWith('untrusted comment:') || !lines[2].startsWith('trusted comment:')) {
    throw new Error('signature must be a four-line minisign signature');
  }
  const signature = strictBase64(lines[1].trim(), 'signature line 2');
  const algorithm = signature.subarray(0, 2).toString('latin1');
  if (signature.length !== 74 || (algorithm !== 'Ed' && algorithm !== 'ED')) {
    throw new Error('signature is not a 74-byte Ed25519 minisign signature');
  }
  if (strictBase64(lines[3].trim(), 'signature line 4').length !== 64) {
    throw new Error('signature global signature must be 64 bytes');
  }
  return { keyId: signature.subarray(2, 10).toString('hex'), trustedComment: lines[2].slice('trusted comment:'.length).trim() };
}
