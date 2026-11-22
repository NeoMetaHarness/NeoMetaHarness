import { spawnSync, execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tauri = join(root, 'apps', 'neo-app', 'src-tauri');
const runtime = join(tauri, 'installer-payload');
const binaries = join(tauri, 'binaries');
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
console.log(`Installer payload ready for ${target}: gateway, extensions and Node sidecar in one hoisted runtime.`);
