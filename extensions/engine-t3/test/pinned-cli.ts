import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { EngineInstallError, readEnginePin } from '@neometaharness/kernel';
import { installT3Cli, installedT3, t3LockFile } from '../src/install.js';

const exec = promisify(execFile);
const cache = join(tmpdir(), 'nmh-test-t3-cli');

async function cachedCli(test: string, repo: string): Promise<string | undefined> {
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const lock = join(cache, '.install-lock');
  const deadline = Date.now() + 180_000;
  while (true) {
    const existing = installedT3(cache, repo);
    if (existing) return existing;
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      assert.ok(Date.now() < deadline, `Timed out waiting for the T3 test cache lock at ${lock}`);
      await delay(250);
    }
  }

  try {
    await installT3Cli(cache, repo, AbortSignal.timeout(120_000));
    const executable = installedT3(cache, repo);
    assert.ok(executable, 'T3 installer completed without a verified CLI');
    return executable;
  } catch (error) {
    if (!(error instanceof EngineInstallError) || error.kind !== 'network') throw error;
    console.log(`${test} SKIP pinned T3 CLI download unavailable: ${error.message}. Retry online or set NMH_TEST_T3_CLI to the pinned CLI.`);
    return undefined;
  } finally {
    await rmdir(lock);
  }
}

/** Returns the pinned CLI or skips the live test when the release cannot be downloaded. */
export async function pinnedTestT3Cli(test: string, repo: string, cwd: string, env: NodeJS.ProcessEnv) {
  const override = process.env.NMH_TEST_T3_CLI;
  const pin = readEnginePin(t3LockFile(repo), 't3code');
  const wasCached = !override && Boolean(installedT3(cache, repo));
  const executable = override ? resolve(override) : await cachedCli(test, repo);
  if (!executable) return undefined;

  const { stdout } = await exec(executable, ['--version'], { cwd, env, windowsHide: true, timeout: 15_000 });
  const version = stdout.trim().split(/\s+/).at(-1)?.replace(/^v/, '');
  assert.equal(version, pin.ref.replace(/^v/, ''), `${test} requires T3 ${pin.ref}: ${executable}`);
  console.log(`${test}_T3_CLI PASS pin=${pin.ref} source=${override ? 'override' : wasCached ? 'cache' : 'verified-cache'}`);
  return executable;
}
