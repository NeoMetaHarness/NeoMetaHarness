import { spawnSync, execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
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

function deploy(packageName, destination) {
  const args = ['--config.strict-dep-builds=false', '--config.verifyDepsBeforeRun=false', '--filter', packageName, 'deploy', '--legacy', destination];
  const deployPath = relative(root, destination).replaceAll('\\\\', '/');
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', `pnpm.cmd --config.strict-dep-builds=false --config.verifyDepsBeforeRun=false --filter ${packageName} deploy --legacy ${deployPath}`], { cwd: root, stdio: 'inherit' })
    : spawnSync('pnpm', args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`pnpm deploy failed for ${packageName}: ${result.error?.message ?? result.status}`);
}

rmSync(runtime, { recursive: true, force: true });
mkdirSync(runtime, { recursive: true });
mkdirSync(binaries, { recursive: true });

mkdirSync(join(runtime, 'apps'), { recursive: true });
deploy('@neometaharness/gateway', join(runtime, 'apps', 'gateway'));
copyFileSync(join(root, 'upstream.lock.json'), join(runtime, 'upstream.lock.json'));
mkdirSync(join(runtime, 'scripts'), { recursive: true });
copyFileSync(join(root, 'scripts', 'upstream.mjs'), join(runtime, 'scripts', 'upstream.mjs'));
mkdirSync(join(runtime, 'upstream'), { recursive: true });
copyFileSync(join(root, 'upstream', 'registry.yaml'), join(runtime, 'upstream', 'registry.yaml'));
const extensions = join(runtime, 'extensions');
mkdirSync(extensions, { recursive: true });
for (const entry of readdirSync(join(root, 'extensions'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const source = join(root, 'extensions', entry.name);
  if (!existsSync(join(source, 'neo.extension.json'))) continue;
  const manifestPath = join(source, 'package.json');
  if (!existsSync(manifestPath)) {
    cpSync(source, join(extensions, entry.name), { recursive: true });
    continue;
  }
  const packageName = JSON.parse(readFileSync(manifestPath, 'utf8')).name;
  deploy(packageName, join(extensions, entry.name));
}

const expectedArch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
if (!expectedArch || !target.startsWith(expectedArch + '-')) {
  throw new Error('The Node runtime architecture must match the Rust target triple.');
}
const suffix = process.platform === 'win32' ? '.exe' : '';
const sidecar = join(binaries, `neo-gateway-${target}${suffix}`);
copyFileSync(process.execPath, sidecar);
if (process.platform !== 'win32') chmodSync(sidecar, 0o755);
console.log(`Installer payload ready for ${target}: gateway, extensions and Node sidecar.`);
