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

export function validateMinisignPublicKey(pubkey) {
  if (typeof pubkey !== 'string') {
    throw new Error('Public key must be a string');
  }
  const trimmed = pubkey.trim();
  if (!trimmed) {
    throw new Error('release installer packaging requires a valid owner minisign public key, not a placeholder or empty string');
  }
  if (trimmed === 'REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY') {
    throw new Error('release installer packaging requires a valid owner minisign public key, not a placeholder or empty string');
  }

  const outerClean = trimmed.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(outerClean) || outerClean.length % 4 !== 0) {
    throw new Error('Public key is not valid base64');
  }

  let fileContent;
  try {
    const outerBytes = Buffer.from(outerClean, 'base64');
    fileContent = outerBytes.toString('utf8');
  } catch (err) {
    throw new Error('Failed to decode public key as UTF-8: ' + err.message);
  }

  const lines = fileContent.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    throw new Error('Minisign public key file must have at least 2 lines (comment and key)');
  }

  if (!lines[0].startsWith('untrusted comment:')) {
    throw new Error('Minisign public key file must begin with "untrusted comment:"');
  }

  const innerClean = lines[1].replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(innerClean) || innerClean.length % 4 !== 0) {
    throw new Error('Minisign public key line 2 is not valid base64');
  }

  const rawKey = Buffer.from(innerClean, 'base64');
  if (rawKey.length !== 42) {
    throw new Error('Minisign public key must decode to exactly 42 bytes, got ' + rawKey.length);
  }

  if (rawKey[0] !== 0x45 || rawKey[1] !== 0x64) {
    throw new Error('Minisign public key algorithm ID must be "Ed", got 0x' + rawKey.subarray(0, 2).toString('hex'));
  }

  return true;
}

export function parseCliConfig(args = process.argv) {
  let merged = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' || args[i] === '-c') {
      const val = args[i + 1];
      if (val) {
        try {
          if (val.trim().startsWith('{')) {
            merged = deepMerge(merged, JSON.parse(val));
          } else if (existsSync(val)) {
            merged = deepMerge(merged, JSON.parse(readFileSync(val, 'utf8').replace(/^\uFEFF/, '')));
          }
        } catch {}
      }
    }
  }
  return merged;
}

export function runInstallerCheck(options = {}) {
  const root = options.root ? resolve(options.root) : resolve(fileURLToPath(new URL('..', import.meta.url)));
  const load = (path) => readFileSync(resolve(root, path), 'utf8').replace(/^\uFEFF/, '');
  const baseConfig = JSON.parse(load('apps/neo-app/src-tauri/tauri.conf.json'));
  let bundleConfigFile = {};
  try {
    bundleConfigFile = JSON.parse(load('apps/neo-app/src-tauri/tauri.bundle.conf.json'));
  } catch {}

  // 1. Validate the default file directly for repository baseline sanity
  assert.match(baseConfig.identifier, /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){2,}$/i, 'valid reverse-DNS identifier');
  assert.equal(baseConfig.identifier, 'com.neometaharness.app', 'desktop app identifier');
  assert.equal(baseConfig.bundle.active, false, 'default config is safe for cargo build and development tests');
  assert.equal(baseConfig.bundle.externalBin, undefined, 'default build requires no staged sidecar');
  assert.equal(baseConfig.bundle.resources, undefined, 'default build requires no staged runtime');
  assert.doesNotMatch(baseConfig.build.beforeBuildCommand ?? '', /installer:prepare/, 'development build does not stage payload');
  assert.match(baseConfig.build.beforeBundleCommand ?? '', /installer-check/, 'tauri.conf.json runs installer-check before packaging bundles');
  assert.deepEqual(baseConfig.plugins?.['deep-link']?.desktop?.schemes, ['neo'], 'desktop deep link survives config merge');

  // 2. Resolve the effective merged configuration
  // Hierarchy: base config -> tauri.bundle.conf.json -> env (TAURI_CONFIG) -> CLI args (--config) -> options overrides
  let envConfig = {};
  if (!options.ignoreEnv) {
    const rawEnv = options.envConfig ?? process.env.TAURI_CONFIG ?? process.env.TAURI_ENV_CONFIG;
    if (rawEnv) {
      try {
        envConfig = typeof rawEnv === 'object' ? rawEnv : JSON.parse(rawEnv);
      } catch (err) {
        throw new Error(`Failed to parse TAURI_CONFIG from environment: ${err.message}`);
      }
    }
  }

  const cliConfig = options.cliConfig ?? parseCliConfig(options.cliArgs ?? process.argv);

  let effectiveConfig = deepMerge(baseConfig, bundleConfigFile);
  effectiveConfig = deepMerge(effectiveConfig, envConfig);
  effectiveConfig = deepMerge(effectiveConfig, cliConfig);

  if (options.installerConfigOverride) {
    effectiveConfig = deepMerge(effectiveConfig, options.installerConfigOverride);
  }
  if (options.configOverride) {
    effectiveConfig = deepMerge(effectiveConfig, options.configOverride);
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
  const pubkey = (updater.pubkey ?? '').trim();

  // Enforce check inside release build path with no bypass on effective merged config
  validateMinisignPublicKey(pubkey);

  assert.ok(Array.isArray(updater.endpoints) && updater.endpoints.length > 0, 'updater endpoint required');
  for (const endpoint of updater.endpoints) {
    const url = new URL(endpoint);
    assert.equal(url.protocol, 'https:', 'updater endpoint uses HTTPS');
    assert.equal(url.username + url.password, '', 'endpoint has no embedded credentials');
    assert.ok(url.pathname.endsWith('.json'), 'endpoint refers to a signed update manifest');
  }

  // Validate allowedHosts in updater config
  const allowedHosts = updater.allowedHosts;
  assert.ok(Array.isArray(allowedHosts) && allowedHosts.length > 0, 'updater allowedHosts must be configured');
  assert.ok(
    allowedHosts.includes('objects.githubusercontent.com') && allowedHosts.includes('release-assets.githubusercontent.com'),
    'updater allowedHosts must include GitHub asset hosts for GitHub Releases feed'
  );

  assert.equal(bundle.createUpdaterArtifacts, false, 'unsigned development builds do not produce updater assets');

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
