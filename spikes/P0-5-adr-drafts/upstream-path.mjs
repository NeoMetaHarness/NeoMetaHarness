import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const upstreamCache = path.resolve(process.env.NMH_UPSTREAM_CACHE || path.join(repoRoot, '..', 'nmh-upstream-cache'));
export const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'upstream.lock.json'), 'utf8'));

export function upstreamPath(name, ...parts) {
  const pin = lock.pins[name];
  if (!pin) throw new Error(`Unpinned upstream: ${name}`);
  const root = path.join(upstreamCache, `${name}@${pin.ref}`);
  const result = path.resolve(root, ...parts);
  if (result !== root && !result.startsWith(root + path.sep)) throw new Error('Upstream path escaped pin');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const name = process.argv[2] || 't3code';
  console.log(JSON.stringify({ name, ref: lock.pins[name]?.ref, resolved: upstreamPath(name), exists: fs.existsSync(upstreamPath(name)), cache: upstreamCache }));
}
