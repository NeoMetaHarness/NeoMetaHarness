import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pin = JSON.parse(readFileSync(join(root, 'upstream.lock.json'), 'utf8')).pins.a2ui;
const destination = join(root, 'extensions', 'a2ui', 'vendor');
const temporary = mkdtempSync(join(tmpdir(), 'neo-a2ui-'));
const source = join(temporary, 'source');
const archive = process.argv[2] ? resolve(process.argv[2]) : join(temporary, 'source.tar.gz');
const windows = process.platform === 'win32';
const env = { ...process.env, NPM_TOKEN: '', npm_config_userconfig: join(temporary, 'npmrc') };

function run(command, args, cwd, override = {}) {
  const options = { cwd, env: { ...env, ...override }, stdio: 'inherit' };
  if (windows && (command === 'corepack' || command === 'npm')) {
    // Arguments to these commands are fixed package names and flags. Paths use cwd.
    execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', `${command}.cmd ${args.join(' ')}`], options);
  } else {
    execFileSync(command, args, options);
  }
}

function prune(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) prune(path);
    else if (entry.name.includes('.test.') || entry.name.endsWith('.map') || entry.name === '.tsbuildinfo') rmSync(path);
  }
}

try {
  if (!/^[a-f0-9]{40}$/.test(pin.commit) || !/^[a-f0-9]{64}$/.test(pin.archive_sha256)) {
    throw new Error('A2UI needs a verified commit and archive checksum.');
  }
  if (!process.argv[2]) {
    const response = await fetch(`https://codeload.github.com/${pin.upstream}/tar.gz/${pin.commit}`);
    if (!response.ok) throw new Error(`A2UI archive download failed with HTTP ${response.status}`);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (digest !== pin.archive_sha256) throw new Error('A2UI archive checksum mismatch.');
  mkdirSync(source);
  // The pinned archive includes symlinks for Dart/Angular examples. Neither build uses them.
  const exclude = [
    'dart/a2ui_flutter/a2ui_explorer/assets/examples/v0_9',
    'dart/a2ui_flutter/a2ui_explorer/assets/examples/v1_0',
    'samples/client/angular/projects/lib/src',
    'typescript/renderers/angular/testing',
    'typescript/renderers/angular/v0_8',
    'typescript/renderers/angular/v0_9',
  ].map((path) => `--exclude=*/${path}`);
  run('tar', ['-xf', archive, '--strip-components', '1', ...exclude], source);
  run('corepack', ['yarn', 'workspaces', 'focus', '@a2ui/web_core'], source,
    { YARN_ENABLE_SCRIPTS: '0', YARN_ENABLE_IMMUTABLE_INSTALLS: 'true' });

  mkdirSync(destination, { recursive: true });
  for (const directory of ['typescript/core/web_core']) {
    const pkg = join(source, directory);
    const dist = join(pkg, 'dist');
    const { name, version } = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
    run(process.execPath, [join(source, 'typescript/scripts/prepare-publish.mjs')], pkg);
    rmSync(join(dist, 'tests'), { recursive: true, force: true });
    prune(dist);
    run('npm', ['pack', '--ignore-scripts', '--silent'], dist);
    const filename = `${name.slice(1).replace('/', '-')}-${version}.tgz`;
    copyFileSync(join(dist, filename), join(destination, filename));
  }
  console.log(`A2UI source build PASS ${pin.commit} ${digest}`);
} finally {
  if (dirname(temporary) === resolve(tmpdir())) rmSync(temporary, { recursive: true, force: true });
}
