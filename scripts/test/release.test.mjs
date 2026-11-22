// P7-11 release tooling: release-manifest.mjs and release-preflight.mjs against fake artifacts, fake
// signatures and a fake repository. TEST-ONLY key material: random bytes in minisign framing, no real key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, githubAssetName, writeRelease } from '../release-manifest.mjs';
import { preflight } from '../release-preflight.mjs';
import { UPDATER_ENDPOINT, changelogSection, parsePublicKey, parseSignature } from '../release-lib.mjs';

const scripts = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const b64 = (value) => Buffer.from(value).toString('base64');
const KEY_ID = Buffer.from('0123456789abcdef', 'hex');
const OTHER_KEY_ID = Buffer.from('fedcba9876543210', 'hex');

/** A fake Tauri public key (base64 of a minisign public key file). */
function fakePublicKey(keyId = KEY_ID) {
  const key = Buffer.concat([Buffer.from('Ed'), keyId, randomBytes(32)]);
  return b64(`untrusted comment: NEO TEST KEY - DO NOT SHIP\n${b64(key)}\n`);
}
/** A fake Tauri .sig (base64 of a minisign signature file) for `file`. */
function fakeSignature(file, keyId = KEY_ID) {
  const signature = Buffer.concat([Buffer.from('ED'), keyId, randomBytes(64)]);
  return b64([
    'untrusted comment: signature from tauri secret key',
    b64(signature),
    `trusted comment: timestamp:1763800000\tfile:${file}`,
    b64(randomBytes(64)),
  ].join('\n') + '\n');
}

const CHANGELOG = '# Changelog\n\n## [1.0.0] - 2027-03-23\n\n### Added\n- Fake release notes.\n\n## [0.1.0]\n\n- Earlier.\n';

/** A fake repository with every version file at `version`. Returns its root. */
function fakeRepo(version = '1.0.0', { lockVersion = version, changelog = CHANGELOG } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nmh-p711-'));
  const tauri = join(root, 'apps/neo-app/src-tauri');
  mkdirSync(tauri, { recursive: true });
  writeFileSync(join(tauri, 'tauri.conf.json'), JSON.stringify({
    productName: 'Neo Meta Harness', version,
    plugins: { updater: { pubkey: 'REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY', endpoints: [UPDATER_ENDPOINT] } },
  }));
  writeFileSync(join(tauri, 'tauri.bundle.conf.json'), JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
  writeFileSync(join(tauri, 'Cargo.toml'), `[package]\nname = "neo-meta-harness"\nversion = "${version}"\n\n[dependencies]\nserde = { version = "1" }\n`);
  writeFileSync(join(tauri, 'Cargo.lock'), `[[package]]\nname = "aaa"\nversion = "9.9.9"\n\n[[package]]\nname = "neo-meta-harness"\nversion = "${lockVersion}"\ndependencies = []\n`);
  writeFileSync(join(root, 'apps/neo-app/package.json'), JSON.stringify({ name: '@neometaharness/neo-app', version }));
  if (changelog !== undefined) writeFileSync(join(root, 'CHANGELOG.md'), changelog);
  return root;
}

/** Fake bundles with signatures, as `tauri build` writes them with TAURI_SIGNING_PRIVATE_KEY set. */
function fakeBundles(root, version = '1.0.0') {
  const dir = join(root, 'bundle');
  mkdirSync(dir, { recursive: true });
  const files = {
    'windows-x86_64-nsis': `Neo Meta Harness_${version}_x64-setup.exe`,
    'windows-x86_64-msi': `Neo Meta Harness_${version}_x64_en-US.msi`,
    'darwin-aarch64-app': 'Neo Meta Harness.app.tar.gz',
    'linux-x86_64-appimage': `neo-meta-harness_${version}_amd64.AppImage`,
  };
  const artifacts = [];
  for (const [platform, name] of Object.entries(files)) {
    const file = join(dir, name);
    writeFileSync(file, `fake ${platform} bundle`);
    writeFileSync(`${file}.sig`, fakeSignature(name));
    artifacts.push({ platform, file });
  }
  return artifacts;
}

const okRun = (calls = []) => (command, args) => {
  calls.push([command, ...args].join(' '));
  return { status: 0, stdout: '', stderr: '' };
};
const releaseOverride = (pubkey = fakePublicKey()) => ({
  bundle: { createUpdaterArtifacts: true }, plugins: { updater: { pubkey } },
});

test('release-manifest: builds latest.json from signed bundles', () => {
  const root = fakeRepo();
  try {
    const artifacts = fakeBundles(root);
    const publicKey = fakePublicKey();
    const { manifest, assets } = buildManifest({ root, version: '1.0.0', artifacts, pubDate: '2027-03-23T10:00:00Z', publicKey });
    assert.equal(manifest.version, '1.0.0');
    assert.equal(manifest.pub_date, '2027-03-23T10:00:00Z');
    assert.equal(manifest.notes, '### Added\n- Fake release notes.', 'notes come from the CHANGELOG entry only');
    assert.deepEqual(Object.keys(manifest.platforms), [
      'darwin-aarch64', 'darwin-aarch64-app', 'linux-x86_64', 'linux-x86_64-appimage',
      'windows-x86_64', 'windows-x86_64-msi', 'windows-x86_64-nsis',
    ]);
    assert.deepEqual(manifest.platforms['windows-x86_64'], manifest.platforms['windows-x86_64-nsis'], 'plain key prefers NSIS');
    const nsis = manifest.platforms['windows-x86_64-nsis'];
    assert.equal(nsis.url, 'https://github.com/NeoMetaHarness/NeoMetaHarness/releases/download/v1.0.0/Neo.Meta.Harness_1.0.0_x64-setup.exe');
    assert.equal(nsis.signature, readFileSync(`${artifacts[0].file}.sig`, 'utf8').trim(), 'signature is the .sig content');
    for (const entry of Object.values(manifest.platforms)) {
      assert.match(entry.url, /^https:\/\/github\.com\/NeoMetaHarness\/NeoMetaHarness\/releases\/download\/v1\.0\.0\/[A-Za-z0-9._+-]+$/);
    }

    const out = join(root, 'out');
    const written = writeRelease({ outDir: out, manifest, assets });
    assert.deepEqual(JSON.parse(readFileSync(written, 'utf8')), manifest);
    assert.deepEqual(readdirSync(out).sort(), [
      'Neo.Meta.Harness.app.tar.gz', 'Neo.Meta.Harness_1.0.0_x64-setup.exe', 'Neo.Meta.Harness_1.0.0_x64_en-US.msi',
      'latest.json', 'neo-meta-harness_1.0.0_amd64.AppImage',
    ], 'assets are staged under the names GitHub serves');
    assert.throws(() => writeRelease({ outDir: out, manifest, assets }), /not empty/, 'never mixes into an old output');
    assert.equal(githubAssetName('Neo Meta Harness_1.0.0_x64-setup.exe'), 'Neo.Meta.Harness_1.0.0_x64-setup.exe');
  } finally { rmSync(root, { recursive: true, force: true }); }
  console.log('P7-11_MANIFEST PASS version notes pub_date per-platform url+signature, GitHub asset names, staged output');
});

test('release-manifest: fails closed on bad inputs', () => {
  const root = fakeRepo();
  try {
    const artifacts = fakeBundles(root);
    const base = { root, version: '1.0.0', artifacts, pubDate: '2027-03-23T10:00:00Z' };
    const rejects = (overrides, pattern, label) => assert.throws(() => buildManifest({ ...base, ...overrides }), pattern, label);

    // Signatures
    rmSync(`${artifacts[2].file}.sig`);
    rejects({}, /darwin-aarch64-app: missing signature/, 'missing .sig');
    writeFileSync(`${artifacts[2].file}.sig`, '');
    rejects({}, /invalid signature.*empty/, 'empty .sig');
    writeFileSync(`${artifacts[2].file}.sig`, b64('not a minisign signature'));
    rejects({}, /invalid signature/, 'malformed .sig');
    writeFileSync(`${artifacts[2].file}.sig`, fakeSignature('other.app.tar.gz'));
    rejects({}, /signs other\.app\.tar\.gz/, 'signature of another file');
    writeFileSync(`${artifacts[2].file}.sig`, fakeSignature('Neo Meta Harness.app.tar.gz'));
    rejects({ publicKey: fakePublicKey(OTHER_KEY_ID) }, /made with key 0123456789abcdef, not the updater key fedcba9876543210/, 'signed with another key');
    rejects({ publicKey: 'REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY' }, /placeholder/, 'placeholder public key');

    // Versions
    rejects({ version: '1.0.1' }, /Version mismatch/, 'repo files are at 1.0.0');
    rejects({ version: '1.0.0-rc.1' }, /without a pre-release suffix/, 'pre-releases are never published');
    const stale = join(root, 'bundle', 'Neo Meta Harness_0.9.0_x64-setup.exe');
    writeFileSync(stale, 'old');
    writeFileSync(`${stale}.sig`, fakeSignature('Neo Meta Harness_0.9.0_x64-setup.exe'));
    rejects({ artifacts: [{ platform: 'windows-x86_64-nsis', file: stale }] }, /built for 0\.9\.0, not 1\.0\.0/, 'stale bundle');

    // URLs
    rejects({ baseUrl: 'http://github.com/NeoMetaHarness/NeoMetaHarness/releases/download/v1.0.0' }, /must be HTTPS/, 'plain HTTP');
    rejects({ baseUrl: 'https://user:pass@github.com/x' }, /credentials/, 'credentials in URL');
    rejects({ baseUrl: 'not a url' }, /not a URL/, 'garbage URL');

    // Artifacts and platforms
    rejects({ artifacts: [] }, /At least one --artifact/, 'no artifacts');
    rejects({ artifacts: [artifacts[0], artifacts[0]] }, /given twice/, 'duplicate platform');
    rejects({ artifacts: [{ platform: 'windows-x86_64', file: artifacts[0].file }] }, /Unknown platform key/, 'installer suffix required');
    rejects({ artifacts: [{ platform: 'darwin-aarch64-app', file: artifacts[0].file }] }, /not a app updater artifact/, 'kind must match the file');
    const dmg = join(root, 'bundle', 'Neo Meta Harness_1.0.0_aarch64.dmg');
    writeFileSync(dmg, 'dmg');
    rejects({ artifacts: [{ platform: 'darwin-aarch64-app', file: dmg }] }, /not a app updater artifact/, 'dmg is not an updater artifact');
    rejects({ artifacts: [{ platform: 'linux-x86_64-appimage', file: join(root, 'missing.AppImage') }] }, /missing or empty/, 'missing file');

    // Notes and dates
    rejects({ notes: '  ' }, /notes are empty/, 'empty notes');
    rejects({ pubDate: 'yesterday' }, /RFC 3339/, 'bad pub_date');
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [0.1.0]\n\n- Earlier.\n');
    rejects({}, /no entry for 1\.0\.0/, 'CHANGELOG entry required');
  } finally { rmSync(root, { recursive: true, force: true }); }

  const lockDrift = fakeRepo('1.0.0', { lockVersion: '0.1.0' });
  try {
    assert.throws(() => buildManifest({ root: lockDrift, version: '1.0.0', artifacts: fakeBundles(lockDrift) }), /Cargo\.lock: 0\.1\.0/);
  } finally { rmSync(lockDrift, { recursive: true, force: true }); }
  console.log('P7-11_MANIFEST_FAIL_CLOSED PASS missing/malformed/foreign signature, wrong key, version mismatch, pre-release, non-HTTPS, bad platform, notes');
});

test('release-manifest CLI: writes the release directory and refuses the private key file', () => {
  const root = fakeRepo();
  try {
    const artifacts = fakeBundles(root);
    const pub = join(root, 'neo-updater.key.pub');
    writeFileSync(pub, fakePublicKey());
    const common = ['--root', root, '--version', '1.0.0', '--pub-date', '2027-03-23T10:00:00Z',
      ...artifacts.flatMap(({ platform, file }) => ['--artifact', `${platform}=${file}`])];
    const cli = (...args) => spawnSync(process.execPath, [join(scripts, 'release-manifest.mjs'), ...args], { encoding: 'utf8' });

    const ok = cli(...common, '--out-dir', join(root, 'out'), '--pubkey-file', pub);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(readFileSync(join(root, 'out', 'latest.json'), 'utf8')).version, '1.0.0');

    const privateKey = cli(...common, '--out-dir', join(root, 'out2'), '--pubkey-file', join(root, 'neo-updater.key'));
    assert.equal(privateKey.status, 1);
    assert.match(privateKey.stderr, /never the private key/);

    const bad = cli('--root', root, '--version', '1.0.0', '--out-dir', join(root, 'out3'),
      '--artifact', `windows-x86_64-nsis=${join(root, 'nope.exe')}`);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /release-manifest FAILED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
  console.log('P7-11_MANIFEST_CLI PASS exit 0 with latest.json; exit 1 on private key path or bad artifact');
});

test('release-preflight: reports every check and passes a ready release', () => {
  const root = fakeRepo();
  try {
    const calls = [];
    const results = preflight({ root, configOverrides: [releaseOverride()], run: okRun(calls) });
    assert.deepEqual(results.map((r) => [r.name, r.ok]), [
      ['version', true], ['updater config', true], ['updater artifacts', true],
      ['working tree', true], ['pnpm check', true], ['changelog', true],
    ], JSON.stringify(results));
    assert.deepEqual(calls, ['git status --porcelain --untracked-files=normal', 'pnpm check'], 'only reads: git status and pnpm check');
  } finally { rmSync(root, { recursive: true, force: true }); }
  console.log('P7-11_PREFLIGHT PASS versions, real pubkey, endpoint, updater artifacts, clean tree, pnpm check, CHANGELOG');
});

test('release-preflight: fails each check without changing anything', () => {
  const failed = (results) => results.filter((r) => !r.ok).map((r) => r.name);
  const root = fakeRepo('1.0.0', { lockVersion: '0.9.0', changelog: '# Changelog\n\n## [0.9.0]\n\n- Old.\n' });
  try {
    const tracked = ['apps/neo-app/src-tauri/tauri.conf.json', 'apps/neo-app/src-tauri/Cargo.lock', 'CHANGELOG.md'];
    const before = tracked.map((f) => readFileSync(join(root, f), 'utf8'));
    const run = (command) => command === 'git'
      ? { status: 0, stdout: ' M apps/gateway/src/server.ts\n?? notes.txt\n', stderr: '' }
      : { status: 1, stdout: '', stderr: 'neo check: 1 check(s) failed' };
    const results = preflight({ root, run });
    assert.deepEqual(failed(results), ['version', 'updater config', 'updater artifacts', 'working tree', 'pnpm check', 'changelog']);
    const detail = Object.fromEntries(results.map((r) => [r.name, r.detail]));
    assert.match(detail.version, /Cargo\.lock: 0\.9\.0 \(expected 1\.0\.0\)/);
    assert.match(detail['updater config'], /placeholder/);
    assert.match(detail['working tree'], /2 uncommitted change/);
    assert.match(detail['pnpm check'], /exited 1/);
    assert.match(detail.changelog, /no non-empty entry for 1\.0\.0/);
    assert.deepEqual(tracked.map((f) => readFileSync(join(root, f), 'utf8')), before, 'report only: no file changes');
  } finally { rmSync(root, { recursive: true, force: true }); }

  const other = fakeRepo();
  try {
    const run = okRun();
    assert.deepEqual(failed(preflight({ root: other, version: '1.0.0-rc.1', configOverrides: [releaseOverride()], run })), ['version', 'changelog']);
    const wrongEndpoint = { plugins: { updater: { endpoints: ['http://example.test/latest.json'] } } };
    assert.deepEqual(failed(preflight({ root: other, configOverrides: [releaseOverride(), wrongEndpoint], run })), ['updater config']);
    const badKey = releaseOverride(b64('untrusted comment: x\nnot-a-key\n'));
    assert.deepEqual(failed(preflight({ root: other, configOverrides: [badKey], run })), ['updater config']);
    const noArtifacts = { plugins: { updater: { pubkey: fakePublicKey() } } };
    assert.deepEqual(failed(preflight({ root: other, configOverrides: [noArtifacts], run })), ['updater artifacts']);
    rmSync(join(other, 'CHANGELOG.md'));
    assert.deepEqual(failed(preflight({ root: other, configOverrides: [releaseOverride()], run })), ['changelog']);
  } finally { rmSync(other, { recursive: true, force: true }); }
  console.log('P7-11_PREFLIGHT_FAIL PASS version drift, pre-release, placeholder/bad key, endpoint, artifacts, dirty tree, pnpm check, CHANGELOG; files unchanged');
});

test('release-lib: minisign parsing and CHANGELOG sections', () => {
  assert.equal(parsePublicKey(fakePublicKey()), '0123456789abcdef');
  assert.throws(() => parsePublicKey(''), /empty/);
  const keyLine = (size) => b64(Buffer.concat([Buffer.from('Ed'), KEY_ID, randomBytes(size)]));
  assert.throws(() => parsePublicKey(b64(`untrusted comment: x\n${keyLine(22)}\n`)), /42-byte/);
  assert.throws(() => parsePublicKey(b64(`untrusted comment: x\n${keyLine(32)}\nthird\n`)), /two-line/);
  assert.throws(() => parsePublicKey(b64(`untrusted comment: x\n${keyLine(32)}\n\n`)), /two-line/);
  assert.equal(parseSignature(fakeSignature('a.msi')).keyId, '0123456789abcdef');
  assert.match(parseSignature(fakeSignature('a.msi')).trustedComment, /file:a\.msi$/);
  assert.throws(() => parseSignature(`${fakeSignature('a.msi')}!`), /base64/);
  assert.equal(changelogSection(CHANGELOG, '1.0.0'), '### Added\n- Fake release notes.');
  assert.equal(changelogSection('## v2.1.0 (2027-05-01)\nNotes\n', '2.1.0'), 'Notes');
  assert.equal(changelogSection(CHANGELOG, '1.0'), undefined);
  assert.equal(changelogSection('## [1.0.00]\nx', '1.0.0'), undefined);
  console.log('P7-11_LIB PASS minisign key/signature framing and CHANGELOG section lookup');
});
