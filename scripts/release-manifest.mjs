#!/usr/bin/env node
// P7-11: build Tauri's updater manifest (latest.json) from locally built, signed bundles.
//
//   node scripts/release-manifest.mjs --version 1.0.0 --out-dir release-out ^
//     --artifact windows-x86_64-nsis="apps/neo-app/src-tauri/target/release/bundle/nsis/Neo Meta Harness_1.0.0_x64-setup.exe" ^
//     [--artifact <platform>=<file> ...]
//
// Each artifact's signature is read from "<file>.sig" (written by the Tauri bundler when
// TAURI_SIGNING_PRIVATE_KEY is set) and verified against the artifact bytes with the updater public key
// checked in to tauri.conf.json. Each artifact must be built for --version: from its file name (bound by
// the signed trusted comment) or, for a macOS .app.tar.gz, from the bundle's Info.plist. The release notes
// are the CHANGELOG.md section for the version and nothing else. The artifacts are copied into --out-dir
// under the names GitHub will serve, next to latest.json, ready for one `gh release create`.
// Fails closed on anything it cannot verify. Offline only: never contacts GitHub and never reads a private key.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoKeyMaterial, assertReleaseVersion, changelogSection, checkedInPublicKey, parseSignature, plistShortVersion,
  readTarGzEntry, readVersions, releaseDownloadBase, verifyMinisign, versionProblems,
} from './release-lib.mjs';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Updater installer kinds Tauri 2 signs, keyed by the platform-key suffix, with the file name they need. */
const KINDS = {
  nsis: { os: 'windows', matches: (name) => /\.exe$/i.test(name) },
  msi: { os: 'windows', matches: (name) => /\.msi$/i.test(name) },
  app: { os: 'darwin', matches: (name) => /\.app\.tar\.gz$/i.test(name) },
  appimage: { os: 'linux', matches: (name) => /\.AppImage$/.test(name) },
  deb: { os: 'linux', matches: (name) => /\.deb$/i.test(name) },
  rpm: { os: 'linux', matches: (name) => /\.rpm$/i.test(name) },
};
/** The installer a plain `<os>-<arch>` entry points at when several are published. */
const PREFERRED = { windows: ['nsis', 'msi'], darwin: ['app'], linux: ['appimage', 'deb', 'rpm'] };
const PLATFORM_KEY = /^(windows|darwin|linux)-(x86_64|aarch64|i686|armv7)-(nsis|msi|app|appimage|deb|rpm)$/;
const INFO_PLIST = /^(?:\.\/)?[^/]+\.app\/Contents\/Info\.plist$/;
const VERSION_IN_NAME = /(?:^|[_-])v?(\d+\.\d+\.\d+)(?=[_.-])/;

/** The name GitHub serves an uploaded asset under (it replaces unsupported characters such as spaces with '.'). */
export function githubAssetName(name) {
  return name.replace(/[^A-Za-z0-9._+-]/g, '.');
}

function assertHttpsBase(base) {
  let url;
  try { url = new URL(base); } catch { throw new Error(`Download base URL is not a URL: ${base}`); }
  if (url.protocol !== 'https:') throw new Error(`Download base URL must be HTTPS: ${base}`);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`Download base URL must not carry credentials, a query or a fragment: ${base}`);
  }
  return url.href.replace(/\/+$/, '');
}

/**
 * The version an artifact was built for. A macOS .app.tar.gz has no version in its name, so it is read from
 * the bundle's Info.plist (CFBundleShortVersionString) inside the signed archive. Every other installer
 * carries it in its file name, which the verified signature's trusted comment binds.
 */
async function artifactVersion(kind, source, name) {
  if (kind === 'app') {
    const plist = await readTarGzEntry(source, (path) => INFO_PLIST.test(path));
    if (!plist) throw new Error(`${name} has no <name>.app/Contents/Info.plist`);
    const found = plistShortVersion(plist.toString('utf8'));
    if (!found) throw new Error(`${name}: Info.plist has no CFBundleShortVersionString`);
    return found;
  }
  const found = VERSION_IN_NAME.exec(name)?.[1];
  if (!found) throw new Error(`${name} has no version in its file name`);
  return found;
}

/**
 * Validate the inputs and build the manifest. Reads only the artifacts, their .sig files, the version files,
 * the checked-in updater public key and CHANGELOG.md (the only source of release notes).
 * Returns { manifest, assets: [{ source, name }] }.
 */
export async function buildManifest({ root = DEFAULT_ROOT, version, artifacts, pubDate, baseUrl, ...rest }) {
  const unknown = Object.keys(rest);
  if (unknown.length) throw new Error(`Unknown option(s): ${unknown.join(', ')}`);
  assertReleaseVersion(version);
  const problems = versionProblems(readVersions(root), version);
  if (problems.length) throw new Error(`Version mismatch:\n  ${problems.join('\n  ')}`);

  const changelog = join(root, 'CHANGELOG.md');
  if (!existsSync(changelog)) throw new Error('CHANGELOG.md is missing; add the release entry');
  const notes = changelogSection(readFileSync(changelog, 'utf8'), version);
  if (notes === undefined) throw new Error(`CHANGELOG.md has no entry for ${version}`);
  if (!notes) throw new Error('Release notes are empty');
  assertNoKeyMaterial(notes, `CHANGELOG.md entry for ${version}`);

  const date = pubDate === undefined ? new Date() : new Date(pubDate);
  if (Number.isNaN(date.getTime()) || (typeof pubDate === 'string' && !/^\d{4}-\d{2}-\d{2}T/.test(pubDate))) {
    throw new Error(`pub_date must be an RFC 3339 timestamp, got ${JSON.stringify(pubDate)}`);
  }

  const base = assertHttpsBase(baseUrl ?? releaseDownloadBase(version));
  const publicKey = checkedInPublicKey(root);

  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error('At least one --artifact is required');
  const platforms = {};
  const assets = [];
  const assetNames = new Set();
  for (const { platform, file } of artifacts) {
    const key = PLATFORM_KEY.exec(platform ?? '');
    if (!key) throw new Error(`Unknown platform key ${JSON.stringify(platform)} (expected e.g. windows-x86_64-nsis)`);
    if (platforms[platform]) throw new Error(`Platform ${platform} is given twice`);
    const [, os, , kind] = key;
    const source = resolve(file ?? '');
    const name = basename(source);
    if (!file || !existsSync(source) || !statSync(source).isFile() || statSync(source).size === 0) {
      throw new Error(`${platform}: artifact missing or empty: ${file}`);
    }
    if (KINDS[kind].os !== os || !KINDS[kind].matches(name)) {
      throw new Error(`${platform}: ${name} is not a ${kind} updater artifact`);
    }

    const sigFile = `${source}.sig`;
    if (!existsSync(sigFile)) throw new Error(`${platform}: missing signature ${basename(sigFile)} (build with TAURI_SIGNING_PRIVATE_KEY set)`);
    const signature = readFileSync(sigFile, 'utf8').trim();
    let parsed;
    try { parsed = parseSignature(signature); }
    catch (error) { throw new Error(`${platform}: invalid signature ${basename(sigFile)}: ${error.message}`); }
    // Verify the signature over the artifact bytes, exactly as the installed updater will.
    try { verifyMinisign(publicKey, await readFile(source), signature); }
    catch (error) { throw new Error(`${platform}: ${basename(sigFile)} does not verify: ${error.message}`); }
    // The signed trusted comment records the signed file name: "timestamp:...\tfile:<name>".
    const signedName = /(?:^|\t)file:([^\t]+)/.exec(parsed.trustedComment)?.[1]?.trim();
    if (signedName !== name) {
      throw new Error(`${platform}: ${basename(sigFile)} signs ${signedName ?? 'no file name'}, not ${name}`);
    }
    let builtFor;
    try { builtFor = await artifactVersion(kind, source, name); }
    catch (error) { throw new Error(`${platform}: ${error.message}`); }
    if (builtFor !== version) throw new Error(`${platform}: ${name} was built for ${builtFor}, not ${version}`);

    const assetName = githubAssetName(name);
    if (assetNames.has(assetName)) throw new Error(`${platform}: two artifacts would be published as ${assetName}`);
    assetNames.add(assetName);
    const url = `${base}/${encodeURIComponent(assetName)}`;
    if (!url.startsWith('https://')) throw new Error(`${platform}: download URL is not HTTPS: ${url}`);
    platforms[platform] = { signature, url };
    assets.push({ source, name: assetName });
  }

  // Tauri 2 looks up "<os>-<arch>-<installer>" first, then "<os>-<arch>": add the plain entry per target.
  for (const platform of Object.keys(platforms)) {
    const [os, arch] = platform.split('-');
    const target = `${os}-${arch}`;
    if (platforms[target]) continue;
    const kind = PREFERRED[os].find((candidate) => platforms[`${target}-${candidate}`]);
    platforms[target] = platforms[`${target}-${kind}`];
  }

  const manifest = {
    version,
    notes,
    pub_date: date.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    platforms: Object.fromEntries(Object.keys(platforms).sort().map((key) => [key, platforms[key]])),
  };
  return { manifest, assets };
}

/** Write latest.json and copy the artifacts into an empty output directory. */
export function writeRelease({ outDir, manifest, assets }) {
  const out = resolve(outDir);
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`Output directory is not empty: ${out}`);
  mkdirSync(out, { recursive: true });
  for (const { source, name } of assets) copyFileSync(source, join(out, name));
  const temporary = join(out, '.latest.json.tmp');
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temporary, join(out, 'latest.json'));
  return join(out, 'latest.json');
}

export function parseArgs(argv) {
  const options = { artifacts: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === '--version') options.version = value();
    else if (flag === '--out-dir') options.outDir = value();
    else if (flag === '--pub-date') options.pubDate = value();
    else if (flag === '--base-url') options.baseUrl = value();
    else if (flag === '--root') options.root = value();
    else if (flag === '--artifact') {
      const spec = value();
      const at = spec.indexOf('=');
      if (at <= 0) throw new Error(`--artifact must be <platform>=<file>, got ${spec}`);
      options.artifacts.push({ platform: spec.slice(0, at), file: spec.slice(at + 1) });
    } else throw new Error(`Unknown option ${flag}`);
  }
  if (!options.version) throw new Error('--version is required');
  if (!options.outDir) throw new Error('--out-dir is required');
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const { manifest, assets } = await buildManifest({
    root: options.root ? resolve(options.root) : DEFAULT_ROOT,
    version: options.version,
    artifacts: options.artifacts,
    pubDate: options.pubDate,
    baseUrl: options.baseUrl,
  });
  const written = writeRelease({ outDir: options.outDir, manifest, assets });
  console.log(`release-manifest: wrote ${written}`);
  for (const key of Object.keys(manifest.platforms)) console.log(`  ${key} -> ${manifest.platforms[key].url}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`release-manifest FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}
