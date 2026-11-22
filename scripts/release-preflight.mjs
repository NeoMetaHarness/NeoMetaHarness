#!/usr/bin/env node
// P7-11: release checklist. Reports only: it never edits files, tags, builds or publishes.
//
//   node scripts/release-preflight.mjs [--version 1.0.0] [--config <tauri override.json> ...]
//
// Checks: the app version agrees everywhere, it is a full X.Y.Z release, the effective updater config
// (tauri.conf.json + tauri.bundle.conf.json + each --config + TAURI_CONFIG) has the real public key, the
// release endpoint and updater artifacts enabled, the working tree is clean, `pnpm check` passes and
// CHANGELOG.md has an entry for the version. Exit code 1 when any check fails.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UPDATER_ENDPOINT, VERSION_FILES, assertReleaseVersion, changelogSection, mergePatch, parsePublicKey, readVersions, versionProblems,
} from './release-lib.mjs';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function defaultRun(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' && command === 'pnpm' });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? result.error?.message ?? '' };
}

/** The Tauri config the release build will use: base, bundle override, then each override in order. */
export function effectiveTauriConfig(root, overrides = []) {
  const tauriDir = join(root, 'apps/neo-app/src-tauri');
  let config = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8'));
  const bundle = join(tauriDir, 'tauri.bundle.conf.json');
  if (existsSync(bundle)) config = mergePatch(config, JSON.parse(readFileSync(bundle, 'utf8')));
  for (const override of overrides) config = mergePatch(config, override);
  return config;
}

/**
 * Run every check. `run(command, args, cwd)` executes git and pnpm (injected in tests).
 * Returns [{ name, ok, detail }].
 */
export function preflight({ root = DEFAULT_ROOT, version, configOverrides = [], run = defaultRun } = {}) {
  const results = [];
  const check = (name, fn) => {
    try {
      const detail = fn();
      results.push({ name, ok: true, detail: detail ?? '' });
    } catch (error) {
      results.push({ name, ok: false, detail: error.message });
    }
  };

  const versions = readVersions(root);
  const target = version ?? versions[VERSION_FILES[0]];
  check('version', () => {
    assertReleaseVersion(target);
    const problems = versionProblems(versions, target);
    if (problems.length) throw new Error(problems.join('; '));
    return `${target} in ${VERSION_FILES.length} files`;
  });

  check('updater config', () => {
    const updater = effectiveTauriConfig(root, configOverrides).plugins?.updater;
    const keyId = parsePublicKey(updater?.pubkey);
    const endpoints = updater?.endpoints ?? [];
    if (endpoints.length !== 1 || endpoints[0] !== UPDATER_ENDPOINT) {
      throw new Error(`updater endpoints must be exactly ["${UPDATER_ENDPOINT}"], got ${JSON.stringify(endpoints)}`);
    }
    return `public key ${keyId}, endpoint ${UPDATER_ENDPOINT}`;
  });

  check('updater artifacts', () => {
    if (effectiveTauriConfig(root, configOverrides).bundle?.createUpdaterArtifacts !== true) {
      throw new Error('bundle.createUpdaterArtifacts is not true; pass the release override with --config');
    }
    return 'createUpdaterArtifacts=true';
  });

  check('working tree', () => {
    const status = run('git', ['status', '--porcelain', '--untracked-files=normal'], root);
    if (status.status !== 0) throw new Error(`git status failed: ${status.stderr.trim()}`);
    const dirty = status.stdout.split(/\r?\n/).filter(Boolean);
    if (dirty.length) throw new Error(`${dirty.length} uncommitted change(s): ${dirty.slice(0, 5).join(', ')}`);
    return 'clean';
  });

  check('pnpm check', () => {
    const result = run('pnpm', ['check'], root);
    if (result.status !== 0) throw new Error(`pnpm check exited ${result.status}: ${(result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join(' | ')}`);
    return 'passed';
  });

  check('changelog', () => {
    const file = join(root, 'CHANGELOG.md');
    if (!existsSync(file)) throw new Error('CHANGELOG.md is missing');
    const section = changelogSection(readFileSync(file, 'utf8'), target ?? '');
    if (!section) throw new Error(`CHANGELOG.md has no non-empty entry for ${target}`);
    return `entry for ${target}`;
  });

  return results;
}

export function parseArgs(argv, env = process.env) {
  const options = { configOverrides: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    if (flag === '--version') options.version = value;
    else if (flag === '--root') options.root = resolve(value);
    else if (flag === '--config') options.configOverrides.push(JSON.parse(readFileSync(value, 'utf8')));
    else throw new Error(`Unknown option ${flag}`);
  }
  // Tauri applies TAURI_CONFIG on top of --config files; check the same effective config.
  if (env.TAURI_CONFIG) options.configOverrides.push(JSON.parse(env.TAURI_CONFIG));
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const results = preflight(parseArgs(argv));
  for (const { name, ok, detail } of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(18)} ${detail}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `release-preflight: ${failed} check(s) failed` : 'release-preflight: ready to build');
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) {
    console.error(`release-preflight FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
