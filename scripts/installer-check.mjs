import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function jsonMergePatch(target, patch) {
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    const result = (target && typeof target === 'object' && !Array.isArray(target))
      ? { ...target }
      : {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        delete result[key];
      } else {
        result[key] = jsonMergePatch(result[key], value);
      }
    }
    return result;
  }
  return patch;
}

export const deepMerge = jsonMergePatch;

function isAsciiWhitespace(code) {
  // Matches Rust's u8::is_ascii_whitespace():
  // 0x20 (SPACE), 0x09 (TAB), 0x0A (LF), 0x0C (FF), 0x0D (CR)
  // Excludes 0x0B (Vertical Tab / '\v')
  return code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0C || code === 0x0D;
}

export function trimAscii(str) {
  if (typeof str !== 'string') return '';
  let start = 0;
  while (start < str.length && isAsciiWhitespace(str.charCodeAt(start))) start++;
  let end = str.length;
  while (end > start && isAsciiWhitespace(str.charCodeAt(end - 1))) end--;
  return str.slice(start, end);
}

export function base64Decode(input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('invalid base64 length');
  }

  // Strict standard base64: no line wrapping, no whitespace, only [A-Za-z0-9+/=]
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const valid =
      (code >= 65 && code <= 90) || // A-Z
      (code >= 97 && code <= 122) || // a-z
      (code >= 48 && code <= 57) || // 0-9
      code === 43 || // +
      code === 47 || // /
      code === 61; // =
    if (!valid) {
      throw new Error(`invalid character in base64: ${input[i]}`);
    }
  }

  if (input.length % 4 !== 0) {
    throw new Error('invalid base64 length');
  }

  // Reject data after '=' and check padding positions
  const firstEq = input.indexOf('=');
  let padCount = 0;
  if (firstEq !== -1) {
    if (firstEq < input.length - 2) {
      throw new Error("invalid padding in base64: '=' can only appear in the last two bytes");
    }
    for (let i = firstEq; i < input.length; i++) {
      if (input[i] !== '=') {
        throw new Error(`invalid character after '=' at index ${i}: ${input[i]}`);
      }
      padCount++;
    }
  }

  const out = [];
  for (let i = 0; i < input.length; i += 4) {
    const isLastChunk = (i === input.length - 4);
    const chunkPad = isLastChunk ? padCount : 0;
    const vals = new Uint32Array(4);
    for (let j = 0; j < 4; j++) {
      const ch = input[i + j];
      const code = ch.charCodeAt(0);
      if (code >= 65 && code <= 90) {
        vals[j] = code - 65;
      } else if (code >= 97 && code <= 122) {
        vals[j] = code - 97 + 26;
      } else if (code >= 48 && code <= 57) {
        vals[j] = code - 48 + 52;
      } else if (code === 43) {
        vals[j] = 62;
      } else if (code === 47) {
        vals[j] = 63;
      } else if (code === 61) {
        if (!isLastChunk || (j < 4 - chunkPad)) {
          throw new Error(`unexpected padding '=' at index ${i + j}`);
        }
        vals[j] = 0;
      } else {
        throw new Error(`invalid character in base64: ${ch}`);
      }
    }

    // Canonical padding: zero unused padding bits
    if (chunkPad === 1) {
      if ((vals[2] & 0x03) !== 0) {
        throw new Error('invalid base64 padding: nonzero unused padding bits');
      }
    } else if (chunkPad === 2) {
      if ((vals[1] & 0x0F) !== 0) {
        throw new Error('invalid base64 padding: nonzero unused padding bits');
      }
    }

    const triple = (vals[0] << 18) | (vals[1] << 12) | (vals[2] << 6) | vals[3];
    out.push((triple >> 16) & 0xff);
    if (chunkPad < 2) {
      out.push((triple >> 8) & 0xff);
    }
    if (chunkPad < 1) {
      out.push(triple & 0xff);
    }
  }

  return Buffer.from(out);
}

export function validateMinisignPublicKey(pubkey) {
  if (typeof pubkey !== 'string') {
    throw new Error('Public key must be a string');
  }
  if (!pubkey) {
    throw new Error('release installer packaging requires a valid owner minisign public key, not a placeholder or empty string');
  }
  if (pubkey === 'REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY') {
    throw new Error('release installer packaging requires a valid owner minisign public key, not a placeholder or empty string');
  }

  let outerBytes;
  try {
    outerBytes = base64Decode(pubkey);
  } catch (err) {
    throw new Error('updater public key is not valid base64: ' + err.message);
  }

  let fileContent;
  try {
    fileContent = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(outerBytes);
  } catch (err) {
    throw new Error('updater public key decoded bytes are not valid UTF-8: ' + err.message);
  }

  let body = fileContent;
  if (body.endsWith('\r\n')) {
    body = body.slice(0, -2);
  } else if (body.endsWith('\n')) {
    body = body.slice(0, -1);
  }

  const lines = body.split(/\r?\n/);
  if (lines.length !== 2) {
    throw new Error(`Minisign public key file must have exactly 2 lines, got ${lines.length}`);
  }

  const line1 = lines[0];
  if (!line1.startsWith('untrusted comment:')) {
    throw new Error('Minisign public key file must begin with "untrusted comment:"');
  }

  const line2 = lines[1];
  if (!line2) {
    throw new Error('Minisign public key line 2 is empty');
  }

  let rawKey;
  try {
    rawKey = base64Decode(line2);
  } catch (err) {
    throw new Error('Minisign public key line 2 is not valid base64: ' + err.message);
  }

  if (rawKey.length !== 42) {
    throw new Error('Minisign public key must decode to exactly 42 bytes, got ' + rawKey.length);
  }

  if (rawKey[0] !== 0x45 || rawKey[1] !== 0x64) {
    throw new Error('Minisign public key algorithm ID must be "Ed", got 0x' + rawKey.subarray(0, 2).toString('hex'));
  }

  const keyIdBytes = rawKey.subarray(2, 10);
  const isTestKeyId = keyIdBytes.equals(Buffer.from('TESTKEY1', 'utf8'));
  if (isTestKeyId || line1 === 'untrusted comment: NEO TEST KEY - DO NOT SHIP') {
    throw new Error("test public key with ID 'TESTKEY1' must not ship in a release build! Put the real public key in apps/neo-app/src-tauri/tauri.conf.json.");
  }

  return true;
}

function parseConfigPatch(text, source) {
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`Release installer packaging failed closed: invalid JSON in ${source}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Release installer packaging failed closed: ${source} must be a JSON object`);
  }
  return parsed;
}

// Returns the --config / -c arguments as an ordered list of JSON merge patches. Patches are not pre-merged: a
// `null` in a later patch has to delete a key from the real base config, which merging into {} would discard.
// Any value that cannot be read or parsed is a hard failure, matching build.rs for TAURI_CONFIG.
export function parseCliConfigPatches(args = process.argv) {
  const patches = [];
  for (let i = 0; i < args.length; i++) {
    let val;
    if (args[i] === '--config' || args[i] === '-c') {
      val = args[i + 1];
      i++;
      if (val === undefined) {
        throw new Error(`Release installer packaging failed closed: ${args[i - 1]} requires a value`);
      }
    } else if (typeof args[i] === 'string' && args[i].startsWith('--config=')) {
      val = args[i].slice('--config='.length);
    } else {
      continue;
    }
    if (val.trim().startsWith('{')) {
      patches.push(parseConfigPatch(val, '--config argument'));
    } else {
      let text;
      try {
        text = readFileSync(val, 'utf8');
      } catch (err) {
        throw new Error(`Release installer packaging failed closed: cannot read --config file ${val}: ${err.message}`);
      }
      patches.push(parseConfigPatch(text, `--config file ${val}`));
    }
  }
  return patches;
}

export function parseCliConfig(args = process.argv) {
  return parseCliConfigPatches(args).reduce((merged, patch) => deepMerge(merged, patch), {});
}

export function runInstallerCheck(options = {}) {
  const root = options.root ? resolve(options.root) : resolve(fileURLToPath(new URL('..', import.meta.url)));
  const load = (path) => readFileSync(resolve(root, path), 'utf8').replace(/^\uFEFF/, '');
  const baseConfig = JSON.parse(load('apps/neo-app/src-tauri/tauri.conf.json'));
  const bundleConfigFile = parseConfigPatch(load('apps/neo-app/src-tauri/tauri.bundle.conf.json'), 'tauri.bundle.conf.json');

  // 1. Validate the default file directly for repository baseline sanity
  assert.match(baseConfig.identifier, /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){2,}$/i, 'valid reverse-DNS identifier');
  assert.equal(baseConfig.identifier, 'com.neometaharness.app', 'desktop app identifier');
  assert.equal(baseConfig.bundle.active, false, 'default config is safe for cargo build and development tests');
  assert.equal(baseConfig.bundle.externalBin, undefined, 'default build requires no staged sidecar');
  assert.equal(baseConfig.bundle.resources, undefined, 'default build requires no staged runtime');
  assert.doesNotMatch(baseConfig.build.beforeBuildCommand ?? '', /installer:prepare/, 'development build does not stage payload');
  assert.match(baseConfig.build.beforeBundleCommand ?? '', /installer-check/, 'tauri.conf.json runs installer-check before packaging bundles');
  assert.deepEqual(baseConfig.plugins?.['deep-link']?.desktop?.schemes, ['neo'], 'desktop deep link survives config merge');

  // The release key is the one checked in to tauri.conf.json. `options.configOverride` patches that checked-in
  // file (a test seam standing in for its contents); nothing else may change the key.
  const checkedInConfig = options.configOverride ? deepMerge(baseConfig, options.configOverride) : baseConfig;
  const checkedInPubkey = checkedInConfig.plugins?.updater?.pubkey;

  // 2. Resolve the effective merged configuration
  // Hierarchy: checked-in config -> tauri.bundle.conf.json -> TAURI_CONFIG -> CLI args (--config) -> options overrides
  //
  // Release builds run with TAURI_CONFIG unset; `tauri build --config ...` sets it from its --config arguments for
  // the compile and its hooks. Neither build.rs nor this hook can tell those arguments from an inherited
  // TAURI_CONFIG, so whatever it holds is merged and the resulting key must still equal the checked-in key.
  // Patches are applied in Tauri's order onto the real base config, each with JSON merge patch semantics (null
  // deletes a key). Anything unparsable fails closed, as build.rs does for TAURI_CONFIG.
  const patches = [];
  if (!options.ignoreEnv) {
    if ('TAURI_ENV_CONFIG' in process.env || process.env.TAURI_ENV_CONFIG !== undefined) {
      throw new Error('Release installer packaging failed closed: TAURI_ENV_CONFIG is not supported by Tauri; pass the release config with --config.');
    }
    const rawEnv = options.envConfig ?? process.env.TAURI_CONFIG;
    if (rawEnv !== undefined) {
      patches.push(typeof rawEnv === 'object' ? rawEnv : parseConfigPatch(rawEnv, 'TAURI_CONFIG'));
    }
  }
  if (options.cliConfig !== undefined) {
    patches.push(options.cliConfig);
  } else {
    patches.push(...parseCliConfigPatches(options.cliArgs ?? process.argv));
  }

  let effectiveConfig = deepMerge(checkedInConfig, bundleConfigFile);
  // The test seam stands for the checked-in files, so it applies before TAURI_CONFIG and --config.
  if (options.configOverride) effectiveConfig = deepMerge(effectiveConfig, options.configOverride);
  for (const patch of patches) effectiveConfig = deepMerge(effectiveConfig, patch);

  if (options.installerConfigOverride) {
    effectiveConfig = deepMerge(effectiveConfig, options.installerConfigOverride);
  }
  if (options.mergedConfigOverride) {
    effectiveConfig = options.mergedConfigOverride;
  }

  const bundle = effectiveConfig.bundle;
  assert.equal(bundle.active, true, 'installer override enables bundling');
  for (const target of ['nsis', 'msi', 'dmg', 'appimage', 'deb']) {
    assert.ok(bundle.targets.includes(target), `missing installer target ${target}`);
  }
  assert.deepEqual(bundle.externalBin, ['binaries/neo-gateway'], 'gateway executable is bundled');
  assert.equal(bundle.resources['installer-payload/'], 'gateway/', 'runtime resources are bundled');
  assert.match(effectiveConfig.build.beforeBuildCommand ?? '', /installer:prepare/, 'installer stages runtime before packaging');
  assert.match(effectiveConfig.build.beforeBundleCommand ?? '', /installer-check/, 'installer runs installer-check before packaging bundles');
  assert.ok(existsSync(resolve(root, 'scripts/installer-prepare.mjs')), 'runtime preparation script');

  const launcher = load('apps/neo-app/src-tauri/src/lib.rs');
  assert.ok(launcher.includes('apps/gateway/src/main.ts'), 'preserves repository-relative gateway paths');
  assert.match(launcher, /resource_dir\(\)\?\.join\("gateway"\)/, 'shell locates packaged runtime');
  assert.match(launcher, /with_file_name\(filename\)/, 'shell invokes packaged Node sidecar');
  assert.match(launcher, /\.env\("NEO_MODE", "desktop"\)/, 'gateway desktop auth');

  const csp = effectiveConfig.app.security.csp;
  assert.equal(typeof csp, 'string', 'CSP is explicit');
  assert.match(csp, /default-src 'self'/, 'CSP restricts default sources');
  assert.match(csp, /script-src 'self'/, 'CSP restricts scripts');
  assert.match(csp, /http:\/\/127\.0\.0\.1:\*/, 'CSP permits loopback gateway HTTP');
  assert.match(csp, /ws:\/\/127\.0\.0\.1:\*/, 'CSP permits loopback gateway WebSocket');
  assert.doesNotMatch(csp, /unsafe-eval|https?:\/\/\*/i, 'CSP forbids script eval and arbitrary remote origins');

  const updater = effectiveConfig.plugins?.updater;
  assert.ok(updater, 'updater config is present');
  const pubkey = updater.pubkey;
  if (typeof pubkey !== 'string') {
    throw new Error('Release installer packaging failed closed: plugins.updater.pubkey is missing from the effective config; the checked-in key in apps/neo-app/src-tauri/tauri.conf.json must not be deleted.');
  }

  // Enforce check inside release build path with no bypass on effective merged config
  validateMinisignPublicKey(pubkey);
  // Fail closed on the key source: TAURI_CONFIG or a --config argument must not swap the key.
  if (pubkey !== checkedInPubkey) {
    throw new Error(
      'Release installer packaging failed closed: the updater public key differs from the key checked in to apps/neo-app/src-tauri/tauri.conf.json. Check the owner key in there; TAURI_CONFIG and --config must not change it.'
    );
  }

  assert.ok(Array.isArray(updater.endpoints) && updater.endpoints.length > 0, 'updater endpoint required');
  assert.deepEqual(
    updater.endpoints,
    ['https://github.com/NeoMetaHarness/NeoMetaHarness/releases/latest/download/latest.json'],
    'production updater endpoint must be exact GitHub Releases feed URL'
  );
  for (const endpoint of updater.endpoints) {
    const url = new URL(endpoint);
    assert.equal(url.protocol, 'https:', 'updater endpoint uses HTTPS');
    assert.equal(url.username + url.password, '', 'endpoint has no embedded credentials');
    assert.ok(url.pathname.endsWith('.json'), 'endpoint refers to a signed update manifest');
  }

  // Validate allowedHosts in updater config
  const allowedHosts = updater.allowedHosts;
  assert.ok(Array.isArray(allowedHosts) && allowedHosts.length > 0, 'updater allowedHosts must be configured');
  const expectedAllowedHosts = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
  assert.deepEqual(
    [...allowedHosts].sort(),
    [...expectedAllowedHosts].sort(),
    'production updater allowedHosts must match fixed GitHub asset hosts'
  );

  assert.equal(typeof bundle.createUpdaterArtifacts, 'boolean', 'bundle.createUpdaterArtifacts must be boolean');
  assert.equal(bundleConfigFile.bundle?.createUpdaterArtifacts, false, 'base bundle config defaults to false without explicit release flag');

  const tracked = execFileSync('git', ['ls-files', 'apps/neo-app/src-tauri', 'scripts/installer-prepare.mjs'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  assert.ok(tracked.every((path) => !/(^|\/)(?:\.env(?:\.|$)|id_rsa|.*(?:private|secret).*\.(?:pem|key|p8|p12|pfx)$)/i.test(path)), 'no credential files committed');
  for (const filename of ['apps/neo-app/src-tauri/tauri.conf.json', 'apps/neo-app/src-tauri/tauri.bundle.conf.json', 'scripts/installer-prepare.mjs']) {
    assert.doesNotMatch(load(filename), /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|TAURI_SIGNING_PRIVATE_KEY\s*[:=]\s*['"][^'"\s]+/i, 'no signing secrets in build files');
  }
  assert.match(load('docs/install.md'), /cargo tauri build --config tauri\.bundle\.conf\.json/, 'installation docs select the bundle-only override');
  assert.match(load('.gitignore'), /apps\/neo-app\/src-tauri\/installer-payload/, 'generated runtime ignored');
  assert.match(load('.gitignore'), /apps\/neo-app\/src-tauri\/binaries\/neo-gateway-/, 'generated node sidecar ignored');

  console.log(`PASS installer:check - identifiers, five installer targets, gateway sidecar, CSP, updater endpoints and allowed hosts, effective merged config enforcement, and secret hygiene`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runInstallerCheck();
}
