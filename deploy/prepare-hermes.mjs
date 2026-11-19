import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export function hermesPlan(ref, root = '/var/lib/neo/upstream') {
  if (!/^v\d+\.\d+\.\d+$/.test(ref) || !root.startsWith('/var/lib/neo/')) throw new Error('Invalid managed Hermes source path/ref');
  const source = `${root}/hermes-agent@${ref}`, cache = '/opt/neo/extensions/engine-hermes/.cache';
  return { source, cache, marker: `${source}|web,sms,telegram\n`, commands: [
    ['git', ['clone', '--depth', '1', '--branch', ref, '--single-branch', 'https://github.com/NousResearch/hermes-agent.git', source]],
    ['uv', ['venv', `${cache}/venv`, '--python', '3.14']],
    ['uv', ['export', '--project', source, '--frozen', '--no-dev', '--no-emit-project', '--extra', 'web', '--extra', 'sms', '--extra', 'telegram', '--format', 'requirements-txt', '--output-file', `${cache}/requirements.txt`, '--quiet']],
    ['uv', ['pip', 'sync', '--python', `${cache}/venv/bin/python`, `${cache}/requirements.txt`]],
  ] };
}
export function prepare(plan, ref, io) {
  io.mkdir(plan.cache); io.mkdir(resolve(plan.source, '..'));
  const run = (command, args) => io.run(command, args);
  if (!io.exists(`${plan.source}/.git`)) run(...plan.commands[0]);
  run('git', ['-C', plan.source, 'diff', '--exit-code', 'HEAD']);
  if (run('git', ['-C', plan.source, 'describe', '--tags', '--exact-match', 'HEAD']).trim() !== ref) throw new Error('Hermes source differs from pinned ref');
  if (!io.exists(`${plan.cache}/venv/bin/python`)) run(...plan.commands[1]);
  run(...plan.commands[2]); run(...plan.commands[3]);
  io.write(`${plan.cache}/venv/.neo-hermes-upstream`, plan.marker);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const lock = JSON.parse(readFileSync(join(root, 'upstream.lock.json'), 'utf8'));
  const ref = lock.pins['hermes-agent'].ref;
  prepare(hermesPlan(ref, process.env.NMH_UPSTREAM_CACHE), ref, {
    exists: existsSync, mkdir: path => mkdirSync(path, { recursive: true }), write: writeFileSync,
    run(command, args) {
      const result = spawnSync(command, args, { encoding: 'utf8', env: process.env });
      if (result.status !== 0) throw new Error(`Hermes preparation failed: ${command}`);
      return result.stdout ?? '';
    },
  });
  console.log('HERMES_PREPARED pinned source and frozen dependencies ready');
}
