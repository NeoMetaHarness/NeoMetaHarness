// P7-16: the Gateway finds the pinned Hermes and dsh-superagent sources only through NMH_UPSTREAM_CACHE (or a cache
// folder inside the checkout). Without it these engines start in install mode, as on an installed app, and a test
// that needs them running would fail later with a misleading error or silently lose coverage. Tests call this first.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const lockFile = fileURLToPath(new URL('../upstream.lock.json', import.meta.url));

/**
 * NMH_UPSTREAM_CACHE, checked to hold the `<pin>@<ref>` folder of each named pin (refs from upstream.lock.json).
 * Throws a message naming the variable when it is unset, missing or incomplete.
 */
export function requireUpstreamCache(test, pins = []) {
  const cache = process.env.NMH_UPSTREAM_CACHE;
  const fix = 'Set NMH_UPSTREAM_CACHE to the pinned upstream source cache (docs/install.md, "Tests and the pinned upstream cache").';
  if (!cache) throw new Error(`${test} needs the pinned engines running. ${fix}`);
  if (!existsSync(cache)) throw new Error(`${test}: NMH_UPSTREAM_CACHE=${cache} does not exist. ${fix}`);
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
  const missing = pins.map((pin) => `${pin}@${lock.pins[pin].ref}`).filter((folder) => !existsSync(join(cache, folder)));
  if (missing.length) throw new Error(`${test}: NMH_UPSTREAM_CACHE=${cache} has no ${missing.join(', ')}. ${fix}`);
  return cache;
}
