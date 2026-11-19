import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const load = (path) => readFileSync(resolve(root, path), 'utf8').replace(/^\uFEFF/, '');
const config = JSON.parse(load('apps/neo-app/src-tauri/tauri.conf.json'));
const bundle = config.bundle;

assert.match(config.identifier, /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){2,}$/i, 'valid reverse-DNS identifier');
assert.equal(config.identifier, 'com.neometaharness.app', 'desktop app identifier');
assert.equal(bundle.active, true, 'bundling enabled');
for (const target of ['nsis', 'msi', 'dmg', 'appimage', 'deb']) {
  assert.ok(bundle.targets.includes(target), `missing installer target ${target}`);
}
assert.deepEqual(bundle.externalBin, ['binaries/neo-gateway'], 'gateway executable is bundled');
assert.equal(bundle.resources['installer-payload/'], 'gateway/', 'runtime resources are bundled');
assert.match(config.build.beforeBuildCommand, /installer:prepare/, 'runtime built before packaging');
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
assert.ok(updater.pubkey === 'REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY' || /^[A-Za-z0-9+/=\s]{40,}$/.test(updater.pubkey), 'public key or explicit placeholder required');
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
for (const filename of ['apps/neo-app/src-tauri/tauri.conf.json', 'scripts/installer-prepare.mjs']) {
  assert.doesNotMatch(load(filename), /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|TAURI_SIGNING_PRIVATE_KEY\s*[:=]\s*['"][^'"\s]+/i, 'no signing secrets in build files');
}
assert.match(load('.gitignore'), /apps\/neo-app\/src-tauri\/installer-payload/, 'generated runtime ignored');
assert.match(load('.gitignore'), /apps\/neo-app\/src-tauri\/binaries\/neo-gateway-/, 'generated node sidecar ignored');

console.log(`PASS installer:check — identifiers, five installer targets, gateway sidecar, CSP, updater endpoints, and secret hygiene${updater.pubkey.startsWith('REPLACE_') ? ' (public key placeholder)' : ''}`);
