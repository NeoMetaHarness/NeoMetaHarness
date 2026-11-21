import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function runInstallerCheck(options = {}) {
  const root = options.root ? resolve(options.root) : resolve(fileURLToPath(new URL('..', import.meta.url)));
  const load = (path) => readFileSync(resolve(root, path), 'utf8').replace(/^\uFEFF/, '');
  const config = options.configOverride ?? JSON.parse(load('apps/neo-app/src-tauri/tauri.conf.json'));
  const installerConfig = options.installerConfigOverride ?? JSON.parse(load('apps/neo-app/src-tauri/tauri.bundle.conf.json'));
  const bundle = installerConfig.bundle;

  assert.match(config.identifier, /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){2,}$/i, 'valid reverse-DNS identifier');
  assert.equal(config.identifier, 'com.neometaharness.app', 'desktop app identifier');
  assert.equal(config.bundle.active, false, 'default config is safe for cargo build and development tests');
  assert.equal(config.bundle.externalBin, undefined, 'default build requires no staged sidecar');
  assert.equal(config.bundle.resources, undefined, 'default build requires no staged runtime');
  assert.doesNotMatch(config.build.beforeBuildCommand ?? '', /installer:prepare/, 'development build does not stage payload');
  assert.match(config.build.beforeBundleCommand ?? '', /installer-check/, 'tauri.conf.json runs installer-check before packaging bundles');
  assert.deepEqual(config.plugins?.['deep-link']?.desktop?.schemes, ['neo'], 'desktop deep link survives config merge');
  assert.equal(bundle.active, true, 'installer override enables bundling');
  for (const target of ['nsis', 'msi', 'dmg', 'appimage', 'deb']) {
    assert.ok(bundle.targets.includes(target), `missing installer target ${target}`);
  }
  assert.deepEqual(bundle.externalBin, ['binaries/neo-gateway'], 'gateway executable is bundled');
  assert.equal(bundle.resources['installer-payload/'], 'gateway/', 'runtime resources are bundled');
  assert.match(installerConfig.build.beforeBuildCommand, /installer:prepare/, 'installer stages runtime before packaging');
  assert.match(installerConfig.build.beforeBundleCommand, /installer-check/, 'installer runs installer-check before packaging bundles');
  assert.ok(existsSync(resolve(root, 'scripts/installer-prepare.mjs')), 'runtime preparation script');
  const launcher = load('apps/neo-app/src-tauri/src/lib.rs');
  assert.ok(launcher.includes('apps/gateway/src/main.ts'), 'preserves repository-relative gateway paths');
  assert.match(launcher, /resource_dir\(\)\?\.join\("gateway"\)/, 'shell locates packaged runtime');
  assert.match(launcher, /with_file_name\(filename\)/, 'shell invokes packaged Node sidecar');
  assert.match(launcher, /\.env\("NEO_MODE", "desktop"\)/, 'gateway desktop auth');

  const csp = config.app.security.csp;
  assert.equal(typeof csp, 'string', 'CSP is explicit');
  assert.match(csp, /default-src 'self'/, 'CSP restricts default sources');
  assert.match(csp, /script-src 'self'/, 'CSP restricts scripts');
  assert.match(csp, /http:\/\/127\.0\.0\.1:\*/, 'CSP permits loopback gateway HTTP');
  assert.match(csp, /ws:\/\/127\.0\.0\.1:\*/, 'CSP permits loopback gateway WebSocket');
  assert.doesNotMatch(csp, /unsafe-eval|https?:\/\/\*/i, 'CSP forbids script eval and arbitrary remote origins');

  const updater = config.plugins?.updater;
  assert.ok(updater, 'updater config is present');
  const pubkey = (updater.pubkey ?? '').trim();

  // Enforce check inside release build path with no bypass
  assert.ok(
    pubkey !== '' && pubkey !== 'REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY',
    'release installer packaging requires a valid owner minisign public key, not a placeholder or empty string'
  );
  assert.match(pubkey, /^[A-Za-z0-9+/=\s]{40,}$/, 'valid base64 minisign public key required for release installer');

  assert.ok(Array.isArray(updater.endpoints) && updater.endpoints.length > 0, 'updater endpoint required');
  for (const endpoint of updater.endpoints) {
    const url = new URL(endpoint);
    assert.equal(url.protocol, 'https:', 'updater endpoint uses HTTPS');
    assert.equal(url.username + url.password, '', 'endpoint has no embedded credentials');
    assert.ok(url.pathname.endsWith('.json'), 'endpoint refers to a signed update manifest');
  }
  assert.equal(bundle.createUpdaterArtifacts, false, 'unsigned development builds do not produce updater assets');

  const tracked = execFileSync('git', ['ls-files', 'apps/neo-app/src-tauri', 'scripts/installer-prepare.mjs'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  assert.ok(tracked.every((path) => !/(^|\/)(?:\.env(?:\.|$)|id_rsa|.*(?:private|secret).*\.(?:pem|key|p8|p12|pfx)$)/i.test(path)), 'no credential files committed');
  for (const filename of ['apps/neo-app/src-tauri/tauri.conf.json', 'apps/neo-app/src-tauri/tauri.bundle.conf.json', 'scripts/installer-prepare.mjs']) {
    assert.doesNotMatch(load(filename), /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|TAURI_SIGNING_PRIVATE_KEY\s*[:=]\s*['"][^'"\s]+/i, 'no signing secrets in build files');
  }
  assert.match(load('docs/install.md'), /cargo tauri build --config tauri\.bundle\.conf\.json/, 'installation docs select the bundle-only override');
  assert.match(load('.gitignore'), /apps\/neo-app\/src-tauri\/installer-payload/, 'generated runtime ignored');
  assert.match(load('.gitignore'), /apps\/neo-app\/src-tauri\/binaries\/neo-gateway-/, 'generated node sidecar ignored');

  console.log(`PASS installer:check — identifiers, five installer targets, gateway sidecar, CSP, updater endpoints, beforeBundleCommand enforcement, and secret hygiene`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runInstallerCheck();
}
