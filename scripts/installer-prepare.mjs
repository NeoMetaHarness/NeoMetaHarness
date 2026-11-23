import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, chmodSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tauri = join(root, 'apps', 'neo-app', 'src-tauri');
const runtime = join(tauri, 'installer-payload');
const binaries = join(tauri, 'binaries');
const archiveDir = join(tauri, 'installer-runtime');
const host = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host:\s*(.+)$/m)?.[1];
const target = process.env.NMH_INSTALL_TARGET ?? host;
if (!host || target !== host) {
  throw new Error('Build the installer on its target OS/architecture with a matching Node runtime.');
}
if (Number(process.versions.node.split('.')[0]) < 22) {
  throw new Error('Installer sidecar requires Node.js 22 or newer.');
}

// The gateway and every extension are deployed ONCE, through a generated aggregate
// package, into a single hoisted node_modules at the payload root. Shared dependencies
// are stored one time and paths stay short (Windows MAX_PATH).
const aggregateName = '@neometaharness/installer-runtime';
const aggregateDir = join(root, 'apps', 'installer-runtime');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function deployAggregate(destination) {
  const deployPath = relative(root, destination).replaceAll('\\', '/');
  const args = ['--config.strict-dep-builds=false', '--config.verifyDepsBeforeRun=false', '--config.node-linker=hoisted', '--filter', aggregateName, 'deploy', '--prod', '--legacy', deployPath];
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', `pnpm.cmd ${args.join(' ')}`], { cwd: root, stdio: 'inherit' })
    : spawnSync('pnpm', args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`pnpm deploy failed for the installer runtime: ${result.error?.message ?? result.status}`);
}

rmSync(runtime, { recursive: true, force: true });
mkdirSync(binaries, { recursive: true });

// Runtime packages: the gateway plus every extension with a package.json (dir name kept).
const packages = [{ name: readJson(join(root, 'apps', 'gateway', 'package.json')).name, target: join('apps', 'gateway') }];
const plainExtensions = [];
for (const entry of readdirSync(join(root, 'extensions'), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory()) continue;
  const source = join(root, 'extensions', entry.name);
  if (!existsSync(join(source, 'neo.extension.json'))) continue;
  if (existsSync(join(source, 'package.json'))) packages.push({ name: readJson(join(source, 'package.json')).name, target: join('extensions', entry.name) });
  else plainExtensions.push(entry.name);
}

// The aggregate is a throwaway, git-ignored workspace member that exists only for this deploy.
if (existsSync(aggregateDir)) throw new Error(`${relative(root, aggregateDir)} already exists; remove it and rerun.`);
mkdirSync(aggregateDir, { recursive: true });
try {
  const dependencies = Object.fromEntries(packages.map(({ name }) => [name, 'workspace:*']));
  writeFileSync(join(aggregateDir, 'package.json'), JSON.stringify({ name: aggregateName, version: '0.0.0', private: true, dependencies }, null, 2) + '\n');
  deployAggregate(runtime);
} finally {
  rmSync(aggregateDir, { recursive: true, force: true });
}
// Deploy bookkeeping is not runtime content.
for (const path of ['package.json', join('node_modules', '.pnpm'), join('node_modules', '.modules.yaml')]) {
  rmSync(join(runtime, path), { recursive: true, force: true });
}

// Move each runtime package out of node_modules to the path the shell expects. Its own
// nested node_modules (version conflicts) travels with it. A package that another
// first-party package depends on is copied instead, so it still resolves from node_modules.
const modules = join(runtime, 'node_modules');
const scope = join(modules, '@neometaharness');
const required = new Set();
for (const name of readdirSync(scope)) {
  for (const dependency of Object.keys(readJson(join(scope, name, 'package.json')).dependencies ?? {})) required.add(dependency);
}
for (const { name, target } of packages) {
  const from = join(modules, ...name.split('/'));
  const to = join(runtime, target);
  if (!existsSync(join(from, 'package.json'))) throw new Error(`${name} missing from the deployed runtime.`);
  mkdirSync(dirname(to), { recursive: true });
  if (required.has(name)) cpSync(from, to, { recursive: true });
  else renameSync(from, to);
}
for (const name of plainExtensions) cpSync(join(root, 'extensions', name), join(runtime, 'extensions', name), { recursive: true });

// Installed apps run sources only: first-party tests stay in the repository.
const firstParty = [
  ...packages.map(({ target }) => join(runtime, target)),
  ...plainExtensions.map((name) => join(runtime, 'extensions', name)),
  ...readdirSync(scope).map((name) => join(scope, name)),
];
for (const dir of firstParty) rmSync(join(dir, 'test'), { recursive: true, force: true });

copyFileSync(join(root, 'upstream.lock.json'), join(runtime, 'upstream.lock.json'));
mkdirSync(join(runtime, 'scripts'), { recursive: true });
copyFileSync(join(root, 'scripts', 'upstream.mjs'), join(runtime, 'scripts', 'upstream.mjs'));
mkdirSync(join(runtime, 'upstream'), { recursive: true });
copyFileSync(join(root, 'upstream', 'registry.yaml'), join(runtime, 'upstream', 'registry.yaml'));

const expectedArch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
if (!expectedArch || !target.startsWith(expectedArch + '-')) {
  throw new Error('The Node runtime architecture must match the Rust target triple.');
}
const suffix = process.platform === 'win32' ? '.exe' : '';
const sidecar = join(binaries, `neo-gateway-${target}${suffix}`);
copyFileSync(process.execPath, sidecar);
const nodeDirectory = dirname(realpathSync(process.execPath));
const licenses = [process.env.NMH_NODE_LICENSE, join(nodeDirectory, 'LICENSE'), join(nodeDirectory, '..', 'LICENSE'), '/usr/share/doc/nodejs/copyright'];
const nodeLicense = licenses.find((path) => path && existsSync(path));
if (!nodeLicense) throw new Error('Node distribution license missing. Set NMH_NODE_LICENSE to its path.');
copyFileSync(nodeLicense, join(runtime, 'NODE-LICENSE.txt'));
if (process.platform !== 'win32') chmodSync(sidecar, 0o755);

// uv (P7-16): Hermes is installed on demand and needs uv to build its Python environment. Bundle the pinned,
// checksum-verified uv release next to the Gateway sidecar (Tauri externalBin binaries/uv -> <install dir>/uv[.exe]).
// NMH_UV_ARCHIVE points at an already downloaded release archive (offline builds); it is verified the same way.
await bundleUv();
async function bundleUv() {
  const uv = readJson(join(root, 'scripts', 'installer-tools.json')).uv;
  const expected = uv.sha256[target];
  if (!/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error(`scripts/installer-tools.json pins no uv ${uv.version} for ${target}.`);
  const ext = target.includes('windows') ? 'zip' : 'tar.gz';
  const work = join(tauri, 'installer-tools');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'extract'), { recursive: true });
  try {
    let archivePath = process.env.NMH_UV_ARCHIVE;
    if (!archivePath) {
      const url = uv.url.replace('{version}', uv.version).replace('{target}', target).replace('{ext}', ext);
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`uv download failed: HTTP ${response.status} for ${url}`);
      archivePath = join(work, `uv-${target}.${ext}`);
      writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
    }
    const actual = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
    if (actual !== expected) throw new Error(`uv archive ${archivePath} has sha256 ${actual}; scripts/installer-tools.json pins ${expected}.`);
    // bsdtar (Windows System32, macOS) reads zip and tar.gz; relative paths keep GNU tar from reading C: as a host.
    const systemTar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const extracted = spawnSync(process.platform === 'win32' && existsSync(systemTar) ? systemTar : 'tar',
      ['-xf', relative(work, resolve(archivePath)), '-C', 'extract'], { cwd: work, stdio: 'inherit' });
    if (extracted.status !== 0) throw new Error(`Extracting uv failed: ${extracted.error?.message ?? extracted.status}`);
    const name = `uv${suffix}`;
    const found = [join(work, 'extract', name), join(work, 'extract', `uv-${target}`, name)].find((path) => existsSync(path));
    if (!found) throw new Error(`uv archive for ${target} has no ${name}.`);
    const destination = join(binaries, `uv-${target}${suffix}`);
    copyFileSync(found, destination);
    if (process.platform !== 'win32') chmodSync(destination, 0o755);
    console.log(`Bundled uv ${uv.version} for ${target} (sha256 ${expected}).`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
// Bundle the payload as ONE uncompressed tar (Tauri resource installer-runtime/ -> runtime/). The shell unpacks it
// into the user's local data dir on first launch, so installers carry one file instead of ~100k loose ones.
// pnpm links packages (junctions on Windows, symlinks elsewhere). tar follows them (-h), as Tauri's resource copy
// did, so each link must resolve inside the payload and must not loop.
const payloadRoot = realpathSync(runtime);
(function verify(directory, ancestors) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const real = realpathSync(path);
    if (real !== payloadRoot && !real.startsWith(payloadRoot + sep)) throw new Error(`Installer payload link leaves the payload: ${relative(runtime, path)}`);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (ancestors.has(real)) throw new Error(`Installer payload link loops: ${relative(runtime, path)}`);
      verify(path, new Set(ancestors).add(real));
    } else if (!stats.isFile()) {
      throw new Error(`Installer payload has an unsupported file type: ${relative(runtime, path)}`);
    }
  }
})(runtime, new Set([payloadRoot]));
rmSync(archiveDir, { recursive: true, force: true });
mkdirSync(archiveDir, { recursive: true });
const archive = join(archiveDir, 'runtime.tar');
// bsdtar ships with Windows 10+ in System32; pax records keep paths longer than 100/260 characters intact.
const systemTar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const tarCommand = process.platform === 'win32' && !existsSync(systemTar) ? 'tar' : systemTar;
// Relative paths only: GNU tar would read "C:\..." as a remote host.
const tarResult = spawnSync(tarCommand, ['--format=pax', '-h', '-cf', relative(tauri, archive), '-C', relative(tauri, runtime), '.'], { cwd: tauri, stdio: 'inherit' });
if (tarResult.status !== 0) throw new Error(`tar failed: ${tarResult.error?.message ?? tarResult.status}`);
const listing = spawnSync(tarCommand, ['-tvf', relative(tauri, archive)], { cwd: tauri, encoding: 'utf8', maxBuffer: 1 << 30 });
if (listing.status !== 0) throw new Error(`tar listing failed: ${listing.error?.message ?? listing.stderr}`);
const listed = listing.stdout.split(/\r?\n/).filter(Boolean);
const entries = listed.length;
// The shell accepts only files, directories and hard links within the runtime.
const unsupported = listed.find((line) => !/^[-dh]/.test(line));
if (unsupported) throw new Error(`Runtime archive has an unsupported entry: ${unsupported}`);
const sha256 = await new Promise((done, fail) => {
  const hash = createHash('sha256');
  createReadStream(archive).on('error', fail).on('data', (chunk) => hash.update(chunk)).on('end', () => done(hash.digest('hex')));
});
const version = JSON.parse(readFileSync(join(tauri, 'tauri.conf.json'), 'utf8').replace(/^﻿/, '')).version;
const size = statSync(archive).size;
writeFileSync(join(archiveDir, 'runtime.json'), JSON.stringify({ version, sha256, size, entries }, null, 2) + '\n');
console.log(`Installer payload ready for ${target}: gateway, extensions and Node sidecar.`);
console.log(`Runtime archive: ${relative(root, archive)} (${size} bytes, ${entries} entries, sha256 ${sha256}).`);
