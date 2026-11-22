// P7-11 release tooling: release-manifest.mjs and release-preflight.mjs against fake artifacts and a fake
// repository. TEST-ONLY key material: Ed25519 key pairs generated per run in minisign framing; no real key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { buildManifest, githubAssetName, writeRelease } from '../release-manifest.mjs';
import { preflight } from '../release-preflight.mjs';
import {
  PLACEHOLDER_PUBKEY, UPDATER_ENDPOINT, changelogSection, parsePublicKey, parseSignature, plistShortVersion, readTarGzEntry,
  verifyMinisign,
} from '../release-lib.mjs';

const scripts = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const b64 = (value) => Buffer.from(value).toString('base64');
const KEY_ID = Buffer.from('0123456789abcdef', 'hex');
const OTHER_KEY_ID = Buffer.from('fedcba9876543210', 'hex');

/** A test-only minisign key pair: { publicKey (Tauri base64 form), sign(file bytes, name, opts) -> .sig text }. */
function testKey(keyId = KEY_ID) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const encoded = b64(`untrusted comment: NEO TEST KEY - DO NOT SHIP\n${b64(Buffer.concat([Buffer.from('Ed'), keyId, raw]))}\n`);
  return {
    publicKey: encoded,
    keyId: keyId.toString('hex'),
    /** A Tauri .sig, made the way `tauri signer sign` makes it (prehashed "ED" unless legacy). */
    sign(data, name, { legacy = false, comment = `timestamp:1763800000\tfile:${name}` } = {}) {
      const signed = legacy ? Buffer.from(data) : createHash('blake2b512').update(data).digest();
      const signature = sign(null, signed, privateKey);
      const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
      return b64([
        'untrusted comment: signature from tauri secret key',
        b64(Buffer.concat([Buffer.from(legacy ? 'Ed' : 'ED'), keyId, signature])),
        `trusted comment: ${comment}`,
        b64(global),
      ].join('\n') + '\n');
    },
  };
}
const KEY = testKey();

/** A minimal tar.gz: entries [{ name, data, type }]. `gnu` writes GNU headers (as the tar crate does). */
function tarGz(entries, { gnu = false } = {}) {
  const parts = [];
  for (const { name, data, type = '0' } of entries) {
    const body = Buffer.from(data);
    const header = Buffer.alloc(512);
    header.write(name.slice(0, 100), 0, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.fill(' ', 148, 156);
    header.write(type, 156);
    header.write(gnu ? 'ustar  \0' : 'ustar\u000000', 257, 'latin1');
    if (gnu) header.write('99999999999\0', 345); // GNU atime: must not be read as a ustar prefix
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    parts.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}
const infoPlist = (version) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n`
  + `  <key>CFBundleName</key>\n  <string>Neo Meta Harness</string>\n`
  + `  <key>CFBundleShortVersionString</key>\n  <string>${version}</string>\n</dict>\n</plist>\n`;
/** A fake macOS updater bundle (.app.tar.gz) for `version`. */
const appTarGz = (version, options) => tarGz([
  { name: 'Neo Meta Harness.app/Contents/MacOS/neo-meta-harness', data: randomBytes(3000) },
  { name: 'Neo Meta Harness.app/Contents/Info.plist', data: infoPlist(version) },
], options);

const CHANGELOG = '# Changelog\n\n## [1.0.0] - 2027-03-23\n\n### Added\n- Fake release notes.\n\n## [0.1.0]\n\n- Earlier.\n';

/** A fake repository with every version file at `version` and `pubkey` checked in. Returns its root. */
function fakeRepo(version = '1.0.0', { lockVersion = version, changelog = CHANGELOG, pubkey = KEY.publicKey } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nmh-p711-'));
  const tauri = join(root, 'apps/neo-app/src-tauri');
  mkdirSync(tauri, { recursive: true });
  writeFileSync(join(tauri, 'tauri.conf.json'), JSON.stringify({
    productName: 'Neo Meta Harness', version,
    plugins: { updater: { pubkey, endpoints: [UPDATER_ENDPOINT] } },
  }));
  writeFileSync(join(tauri, 'tauri.bundle.conf.json'), JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
  writeFileSync(join(tauri, 'Cargo.toml'), `[package]\nname = "neo-meta-harness"\nversion = "${version}"\n\n[dependencies]\nserde = { version = "1" }\n`);
  writeFileSync(join(tauri, 'Cargo.lock'), `[[package]]\nname = "aaa"\nversion = "9.9.9"\n\n[[package]]\nname = "neo-meta-harness"\nversion = "${lockVersion}"\ndependencies = []\n`);
  writeFileSync(join(root, 'apps/neo-app/package.json'), JSON.stringify({ name: '@neometaharness/neo-app', version }));
  if (changelog !== undefined) writeFileSync(join(root, 'CHANGELOG.md'), changelog);
  return root;
}

/** Write `data` as `name` in `dir` with a .sig from `key`. Returns the artifact path. */
function signedArtifact(dir, name, data, key = KEY, options) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, data);
  writeFileSync(`${file}.sig`, key.sign(readFileSync(file), name, options));
  return file;
}

/** Fake signed bundles, as `tauri build` writes them with TAURI_SIGNING_PRIVATE_KEY set. */
function fakeBundles(root, version = '1.0.0') {
  const dir = join(root, 'bundle');
  const files = {
    'windows-x86_64-nsis': [`Neo Meta Harness_${version}_x64-setup.exe`, randomBytes(2048)],
    'windows-x86_64-msi': [`Neo Meta Harness_${version}_x64_en-US.msi`, randomBytes(2048)],
    'darwin-aarch64-app': ['Neo Meta Harness.app.tar.gz', appTarGz(version)],
    'linux-x86_64-appimage': [`neo-meta-harness_${version}_amd64.AppImage`, randomBytes(2048)],
    'linux-x86_64-deb': [`neo-meta-harness_${version}_amd64.deb`, randomBytes(2048)],
  };
  return Object.entries(files).map(([platform, [name, data]]) => ({ platform, file: signedArtifact(dir, name, data) }));
}

const okRun = (calls = []) => (command, args) => {
  calls.push([command, ...args].join(' '));
  return { status: 0, stdout: '', stderr: '' };
};
/** The runbook's release override: only createUpdaterArtifacts. The public key stays the checked-in one. */
const RELEASE_OVERRIDE = { bundle: { createUpdaterArtifacts: true } };

test('release-manifest: builds latest.json from verified, signed bundles', async () => {
  const root = fakeRepo();
  try {
    const artifacts = fakeBundles(root);
    const { manifest, assets } = await buildManifest({ root, version: '1.0.0', artifacts, pubDate: '2027-03-23T10:00:00Z' });
    assert.equal(manifest.version, '1.0.0');
    assert.equal(manifest.pub_date, '2027-03-23T10:00:00Z');
    assert.equal(manifest.notes, '### Added\n- Fake release notes.', 'notes come from the CHANGELOG entry only');
    assert.deepEqual(Object.keys(manifest.platforms), [
      'darwin-aarch64', 'darwin-aarch64-app', 'linux-x86_64', 'linux-x86_64-appimage', 'linux-x86_64-deb',
      'windows-x86_64', 'windows-x86_64-msi', 'windows-x86_64-nsis',
    ]);
    assert.deepEqual(manifest.platforms['windows-x86_64'], manifest.platforms['windows-x86_64-nsis'], 'plain key prefers NSIS');
    // P1-11: deb installs request linux-<arch>-deb, AppImage installs linux-<arch>-appimage. Both are signed entries.
    const deb = manifest.platforms['linux-x86_64-deb'];
    assert.equal(deb.url, 'https://github.com/NeoMetaHarness/NeoMetaHarness/releases/download/v1.0.0/neo-meta-harness_1.0.0_amd64.deb');
    assert.equal(deb.signature, readFileSync(`${artifacts[4].file}.sig`, 'utf8').trim(), 'deb signature is its own .sig');
    assert.notEqual(deb.url, manifest.platforms['linux-x86_64-appimage'].url);
    assert.deepEqual(manifest.platforms['linux-x86_64'], manifest.platforms['linux-x86_64-appimage'], 'plain key prefers the AppImage');
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
      'latest.json', 'neo-meta-harness_1.0.0_amd64.AppImage', 'neo-meta-harness_1.0.0_amd64.deb',
    ], 'assets are staged under the names GitHub serves');
    assert.throws(() => writeRelease({ outDir: out, manifest, assets }), /not empty/, 'never mixes into an old output');
    assert.equal(githubAssetName('Neo Meta Harness_1.0.0_x64-setup.exe'), 'Neo.Meta.Harness_1.0.0_x64-setup.exe');
  } finally { rmSync(root, { recursive: true, force: true }); }
  console.log('P7-11_MANIFEST PASS verified signatures, linux deb+appimage entries, version, CHANGELOG notes, pub_date, per-platform url, GitHub asset names');
});

test('release-manifest: fails closed on bad inputs', async () => {
  const root = fakeRepo();
  try {
    const artifacts = fakeBundles(root);
    const dir = join(root, 'bundle');
    const base = { root, version: '1.0.0', artifacts, pubDate: '2027-03-23T10:00:00Z' };
    const rejects = (overrides, pattern, label) => assert.rejects(buildManifest({ ...base, ...overrides }), pattern, label);
    const mac = artifacts[2].file;
    const macSig = `${mac}.sig`;
    const goodMacSig = readFileSync(macSig, 'utf8');

    // Signature framing
    rmSync(macSig);
    await rejects({}, /darwin-aarch64-app: missing signature/, 'missing .sig');
    writeFileSync(macSig, '');
    await rejects({}, /invalid signature.*empty/, 'empty .sig');
    writeFileSync(macSig, b64('not a minisign signature'));
    await rejects({}, /invalid signature/, 'malformed .sig');

    // Signature verification against the bytes
    writeFileSync(macSig, goodMacSig);
    const tampered = signedArtifact(dir, `Neo Meta Harness_1.0.0_x64-tampered.exe`, randomBytes(4096));
    const bytes = readFileSync(tampered);
    bytes[100] ^= 0xff;
    writeFileSync(tampered, bytes);
    await rejects({ artifacts: [{ platform: 'windows-x86_64-nsis', file: tampered }] },
      /windows-x86_64-nsis: .*\.sig does not verify: signature does not match the file contents/, 'tampered artifact bytes');
    const decoded = Buffer.from(goodMacSig.trim(), 'base64').toString('utf8');
    writeFileSync(macSig, b64(decoded.replace('file:Neo Meta Harness.app.tar.gz', 'file:Neo Meta Harness.app.tar.gz2')));
    await rejects({}, /trusted comment signature does not verify/, 'edited trusted comment');
    writeFileSync(macSig, KEY.sign(readFileSync(mac), 'other.app.tar.gz'));
    await rejects({}, /signs other\.app\.tar\.gz, not Neo Meta Harness\.app\.tar\.gz/, 'signature of another file name');
    writeFileSync(macSig, KEY.sign(readFileSync(mac), 'x', { comment: 'timestamp:1763800000' }));
    await rejects({}, /signs no file name/, 'trusted comment without a file name');
    writeFileSync(macSig, testKey(OTHER_KEY_ID).sign(readFileSync(mac), 'Neo Meta Harness.app.tar.gz'));
    await rejects({}, /made with key fedcba9876543210, not the updater key 0123456789abcdef/, 'signed with another key');
    writeFileSync(macSig, testKey(KEY_ID).sign(readFileSync(mac), 'Neo Meta Harness.app.tar.gz'));
    await rejects({}, /signature does not match the file contents/, 'another key that reuses the key id');
    writeFileSync(macSig, goodMacSig);

    // Versions
    await rejects({ version: '1.0.1' }, /Version mismatch/, 'repo files are at 1.0.0');
    await rejects({ version: '1.0.0-rc.1' }, /without a pre-release suffix/, 'pre-releases are never published');
    const stale = signedArtifact(dir, 'Neo Meta Harness_0.9.0_x64-setup.exe', randomBytes(512));
    await rejects({ artifacts: [{ platform: 'windows-x86_64-nsis', file: stale }] }, /built for 0\.9\.0, not 1\.0\.0/, 'stale bundle (name)');
    const unversioned = signedArtifact(dir, 'Neo Meta Harness-setup.exe', randomBytes(512));
    await rejects({ artifacts: [{ platform: 'windows-x86_64-nsis', file: unversioned }] }, /no version in its file name/, 'version required in name');
    const oldMac = signedArtifact(join(dir, 'old'), 'Neo Meta Harness.app.tar.gz', appTarGz('0.9.0'));
    await rejects({ artifacts: [{ platform: 'darwin-aarch64-app', file: oldMac }] },
      /darwin-aarch64-app: Neo Meta Harness\.app\.tar\.gz was built for 0\.9\.0, not 1\.0\.0/, 'validly signed old .app.tar.gz');
    const noPlist = signedArtifact(join(dir, 'noplist'), 'Neo Meta Harness.app.tar.gz', tarGz([{ name: 'x.app/Contents/MacOS/x', data: 'x' }]));
    await rejects({ artifacts: [{ platform: 'darwin-aarch64-app', file: noPlist }] }, /has no <name>\.app\/Contents\/Info\.plist/, 'no Info.plist');
    const notTar = signedArtifact(join(dir, 'nottar'), 'Neo Meta Harness.app.tar.gz', randomBytes(600));
    await rejects({ artifacts: [{ platform: 'darwin-aarch64-app', file: notTar }] }, /darwin-aarch64-app: /, 'not a gzip tar');

    // Public key: the checked-in key is required
    const placeholder = fakeRepo('1.0.0', { pubkey: PLACEHOLDER_PUBKEY });
    try {
      await assert.rejects(buildManifest({ ...base, root: placeholder }), /tauri\.conf\.json: updater public key is still the placeholder/);
    } finally { rmSync(placeholder, { recursive: true, force: true }); }

    // URLs
    await rejects({ baseUrl: 'http://github.com/NeoMetaHarness/NeoMetaHarness/releases/download/v1.0.0' }, /must be HTTPS/, 'plain HTTP');
    await rejects({ baseUrl: 'https://user:pass@github.com/x' }, /credentials/, 'credentials in URL');
    await rejects({ baseUrl: 'not a url' }, /not a URL/, 'garbage URL');

    // Artifacts and platforms
    await rejects({ artifacts: [] }, /At least one --artifact/, 'no artifacts');
    await rejects({ artifacts: [artifacts[0], artifacts[0]] }, /given twice/, 'duplicate platform');
    await rejects({ artifacts: [{ platform: 'windows-x86_64', file: artifacts[0].file }] }, /Unknown platform key/, 'installer suffix required');
    await rejects({ artifacts: [{ platform: 'darwin-aarch64-app', file: artifacts[0].file }] }, /not a app updater artifact/, 'kind must match the file');
    const dmg = signedArtifact(dir, 'Neo Meta Harness_1.0.0_aarch64.dmg', 'dmg');
    await rejects({ artifacts: [{ platform: 'darwin-aarch64-app', file: dmg }] }, /not a app updater artifact/, 'dmg is not an updater artifact');
    await rejects({ artifacts: [{ platform: 'linux-x86_64-appimage', file: join(root, 'missing.AppImage') }] }, /missing or empty/, 'missing file');

    // Notes: the CHANGELOG section is the only source
    await rejects({ notes: 'anything' }, /Unknown option\(s\): notes/, 'no notes override');
    await rejects({ publicKey: KEY.publicKey }, /Unknown option\(s\): publicKey/, 'no public key override');
    await rejects({ pubDate: 'yesterday' }, /RFC 3339/, 'bad pub_date');
    writeFileSync(join(root, 'CHANGELOG.md'), `## [1.0.0]\n\n${Buffer.from('untrusted comment: rsign encrypted secret key\nRWRTY0Iy\n').toString('base64')}\n`);
    await rejects({}, /contains key material/, 'synthetic secret key pasted into the CHANGELOG');
    writeFileSync(join(root, 'CHANGELOG.md'), '## [1.0.0]\n\n## [0.1.0]\n- Earlier.\n');
    await rejects({}, /notes are empty/, 'empty CHANGELOG entry');
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [0.1.0]\n\n- Earlier.\n');
    await rejects({}, /no entry for 1\.0\.0/, 'CHANGELOG entry required');
  } finally { rmSync(root, { recursive: true, force: true }); }

  const lockDrift = fakeRepo('1.0.0', { lockVersion: '0.1.0' });
  try {
    await assert.rejects(buildManifest({ root: lockDrift, version: '1.0.0', artifacts: fakeBundles(lockDrift) }), /Cargo\.lock: 0\.1\.0/);
  } finally { rmSync(lockDrift, { recursive: true, force: true }); }
  console.log('P7-11_MANIFEST_FAIL_CLOSED PASS tampered bytes/comment, foreign file/key, placeholder key, stale name and Info.plist, URLs, platforms, notes, key material');
});

test('release-manifest CLI: writes the release directory; no notes or key file options', () => {
  const root = fakeRepo();
  try {
    const artifacts = fakeBundles(root);
    const common = ['--root', root, '--version', '1.0.0', '--pub-date', '2027-03-23T10:00:00Z',
      ...artifacts.flatMap(({ platform, file }) => ['--artifact', `${platform}=${file}`])];
    const cli = (...args) => spawnSync(process.execPath, [join(scripts, 'release-manifest.mjs'), ...args], { encoding: 'utf8' });

    const ok = cli(...common, '--out-dir', join(root, 'out'));
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(readFileSync(join(root, 'out', 'latest.json'), 'utf8')).version, '1.0.0');

    // Regression: --notes-file used to copy any file into latest.json. Synthetic secret key, never a real one.
    const secret = join(root, 'neo-updater.key');
    const marker = `SYNTHETIC-${randomBytes(8).toString('hex')}`;
    writeFileSync(secret, b64(`untrusted comment: rsign encrypted secret key\n${b64(marker)}\n`));
    const notesFile = cli(...common, '--out-dir', join(root, 'out2'), '--notes-file', secret);
    assert.equal(notesFile.status, 1);
    assert.match(notesFile.stderr, /Unknown option --notes-file/);
    assert.equal(existsSync(join(root, 'out2')), false, 'nothing is written');
    assert.doesNotMatch(notesFile.stdout + notesFile.stderr, new RegExp(marker));

    const pubkeyFile = cli(...common, '--out-dir', join(root, 'out3'), '--pubkey-file', secret);
    assert.equal(pubkeyFile.status, 1);
    assert.match(pubkeyFile.stderr, /Unknown option --pubkey-file/);

    const bad = cli('--root', root, '--version', '1.0.0', '--out-dir', join(root, 'out4'),
      '--artifact', `windows-x86_64-nsis=${join(root, 'nope.exe')}`);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /release-manifest FAILED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
  console.log('P7-11_MANIFEST_CLI PASS exit 0 with latest.json; --notes-file (synthetic secret key) and --pubkey-file refused, nothing written');
});

test('release-preflight: reports every check and passes a ready release', () => {
  const root = fakeRepo();
  try {
    const calls = [];
    const results = preflight({ root, configOverrides: [RELEASE_OVERRIDE], run: okRun(calls) });
    assert.deepEqual(results.map((r) => [r.name, r.ok]), [
      ['version', true], ['updater config', true], ['updater artifacts', true],
      ['working tree', true], ['pnpm check', true], ['changelog', true],
    ], JSON.stringify(results));
    assert.match(results[1].detail, /checked-in public key 0123456789abcdef/);
    assert.deepEqual(calls, ['git status --porcelain --untracked-files=normal', 'pnpm check'], 'only reads: git status and pnpm check');
  } finally { rmSync(root, { recursive: true, force: true }); }
  console.log('P7-11_PREFLIGHT PASS versions, checked-in pubkey, endpoint, updater artifacts, clean tree, pnpm check, CHANGELOG');
});

test('release-preflight: fails each check without changing anything', () => {
  const failed = (results) => results.filter((r) => !r.ok).map((r) => r.name);
  const detailOf = (results, name) => results.find((r) => r.name === name).detail;
  const root = fakeRepo('1.0.0', { lockVersion: '0.9.0', changelog: '# Changelog\n\n## [0.9.0]\n\n- Old.\n', pubkey: PLACEHOLDER_PUBKEY });
  try {
    const tracked = ['apps/neo-app/src-tauri/tauri.conf.json', 'apps/neo-app/src-tauri/Cargo.lock', 'CHANGELOG.md'];
    const before = tracked.map((f) => readFileSync(join(root, f), 'utf8'));
    const run = (command) => command === 'git'
      ? { status: 0, stdout: ' M apps/gateway/src/server.ts\n?? notes.txt\n', stderr: '' }
      : { status: 1, stdout: '', stderr: 'neo check: 1 check(s) failed' };
    const results = preflight({ root, run });
    assert.deepEqual(failed(results), ['version', 'updater config', 'updater artifacts', 'working tree', 'pnpm check', 'changelog']);
    assert.match(detailOf(results, 'version'), /Cargo\.lock: 0\.9\.0 \(expected 1\.0\.0\)/);
    assert.match(detailOf(results, 'updater config'), /tauri\.conf\.json: updater public key is still the placeholder/);
    assert.match(detailOf(results, 'working tree'), /2 uncommitted change/);
    assert.match(detailOf(results, 'pnpm check'), /exited 1/);
    assert.match(detailOf(results, 'changelog'), /no non-empty entry for 1\.0\.0/);
    // An override with a real key must not hide the checked-in placeholder.
    const hidden = preflight({ root, configOverrides: [{ ...RELEASE_OVERRIDE, plugins: { updater: { pubkey: KEY.publicKey } } }], run: okRun() });
    assert.match(detailOf(hidden, 'updater config'), /tauri\.conf\.json: updater public key is still the placeholder/);
    assert.deepEqual(tracked.map((f) => readFileSync(join(root, f), 'utf8')), before, 'report only: no file changes');
  } finally { rmSync(root, { recursive: true, force: true }); }

  const other = fakeRepo();
  try {
    const run = okRun();
    const check = (overrides, extra = {}) => preflight({ root: other, configOverrides: [RELEASE_OVERRIDE, ...overrides], run, ...extra });
    assert.deepEqual(failed(check([], { version: '1.0.0-rc.1' })), ['version', 'updater config', 'changelog']);
    const swapped = check([{ plugins: { updater: { pubkey: testKey(OTHER_KEY_ID).publicKey } } }]);
    assert.deepEqual(failed(swapped), ['updater config']);
    assert.match(detailOf(swapped, 'updater config'), /override changes the updater public key/);
    assert.deepEqual(failed(check([{ plugins: { updater: { pubkey: null } } }])), ['updater config'], 'override removes the key');
    assert.deepEqual(failed(check([{ plugins: { updater: { endpoints: ['http://example.test/latest.json'] } } }])), ['updater config']);
    const version = check([{ version: '9.9.9' }]);
    assert.deepEqual(failed(version), ['updater config']);
    assert.match(detailOf(version, 'updater config'), /effective config version is "9\.9\.9", not 1\.0\.0/);
    assert.deepEqual(failed(preflight({ root: other, run })), ['updater artifacts'], 'no override: no .sig files');
    rmSync(join(other, 'CHANGELOG.md'));
    assert.deepEqual(failed(check([])), ['changelog']);
  } finally { rmSync(other, { recursive: true, force: true }); }

  const badKey = fakeRepo('1.0.0', { pubkey: b64('untrusted comment: x\nnot-a-key\n') });
  try {
    assert.deepEqual(failed(preflight({ root: badKey, configOverrides: [RELEASE_OVERRIDE], run: okRun() })), ['updater config']);
  } finally { rmSync(badKey, { recursive: true, force: true }); }
  console.log('P7-11_PREFLIGHT_FAIL PASS placeholder hidden by override, swapped/removed key, endpoint, version override, artifacts, dirty tree, pnpm check, CHANGELOG; files unchanged');
});

test('release-lib: minisign verification, tar Info.plist and CHANGELOG sections', async () => {
  assert.equal(parsePublicKey(KEY.publicKey), '0123456789abcdef');
  assert.throws(() => parsePublicKey(''), /empty/);
  const keyLine = (size) => b64(Buffer.concat([Buffer.from('Ed'), KEY_ID, randomBytes(size)]));
  assert.throws(() => parsePublicKey(b64(`untrusted comment: x\n${keyLine(22)}\n`)), /42-byte/);
  assert.throws(() => parsePublicKey(b64(`untrusted comment: x\n${keyLine(32)}\nthird\n`)), /two-line/);
  assert.throws(() => parsePublicKey(b64(`untrusted comment: x\n${keyLine(32)}\n\n`)), /two-line/);

  const data = randomBytes(1000);
  const sig = KEY.sign(data, 'a.msi');
  assert.equal(parseSignature(sig).keyId, '0123456789abcdef');
  assert.equal(parseSignature(sig).trustedComment, 'timestamp:1763800000\tfile:a.msi');
  assert.equal(verifyMinisign(KEY.publicKey, data, sig).prehashed, true);
  assert.equal(verifyMinisign(KEY.publicKey, data, KEY.sign(data, 'a.msi', { legacy: true })).prehashed, false, 'legacy Ed accepted, as Tauri does');
  assert.throws(() => verifyMinisign(KEY.publicKey, Buffer.concat([data, Buffer.from([0])]), sig), /does not match the file contents/);
  assert.throws(() => parseSignature(`${sig}!`), /base64/);

  for (const gnu of [false, true]) {
    const archive = join(mkdtempSync(join(tmpdir(), 'nmh-p711-tar-')), 'a.tar.gz');
    const long = `${'L'.repeat(120)}.app/Contents/Info.plist`;
    writeFileSync(archive, tarGz([
      { name: 'skip.bin', data: randomBytes(5000) },
      gnu ? { name: '././@LongLink', type: 'L', data: `${long}\0` } : { name: 'PaxHeader', type: 'x', data: `${` path=${long}\n`.length + 3} path=${long}\n` },
      { name: 'truncated', data: infoPlist('2.3.4') },
    ], { gnu }));
    const found = await readTarGzEntry(archive, (path) => path === long);
    assert.equal(plistShortVersion(found.toString('utf8')), '2.3.4', gnu ? 'GNU long name' : 'pax path');
    rmSync(dirname(archive), { recursive: true, force: true });
  }
  assert.throws(() => plistShortVersion('bplist00...'), /binary plist/);

  assert.equal(changelogSection(CHANGELOG, '1.0.0'), '### Added\n- Fake release notes.');
  assert.equal(changelogSection('## v2.1.0 (2027-05-01)\nNotes\n', '2.1.0'), 'Notes');
  assert.equal(changelogSection(CHANGELOG, '1.0'), undefined);
  assert.equal(changelogSection('## [1.0.00]\nx', '1.0.0'), undefined);
  console.log('P7-11_LIB PASS Ed25519/BLAKE2b minisign verify (ED and legacy Ed), tar long names, Info.plist, CHANGELOG sections');
});
