import { lstat, readdir, mkdir, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, parse } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { verifyArchive } from './archive.js';

function overlaps(a: string, b: string): boolean {
  const inside = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  return inside(a, b) || inside(b, a);
}
async function rejectLinks(path: string) {
  let current = resolve(path);
  while (true) {
    const stat = await lstat(current).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
    if (stat?.isSymbolicLink()) throw new Error('Restore refuses symbolic links in destination');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Validate everything before staging; publish by rename, with rollback on failure. */
export async function restoreBackup(options: { archive: string; dataDir: string; passphrase: string; force?: boolean },
  protectedPaths: string[] = []) {
  const { manifest, files } = await verifyArchive(options.archive, options.passphrase);
  const target = resolve(options.dataDir);
  if (target === parse(target).root || target === resolve(homedir()) ||
      protectedPaths.some(path => overlaps(target, resolve(path)))) throw new Error('Restore destination overlaps protected live data');
  await rejectLinks(target);
  const current = await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
  if (current && !current.isDirectory()) throw new Error('Restore destination must be a directory');
  if (current && (await readdir(target)).length && !options.force) throw new Error('Restore destination is non-empty; use --force to replace it');
  await mkdir(dirname(target), { recursive: true });
  const stage = await mkdtemp(join(dirname(target), '.neo-restore-'));
  const previous = `${stage}.previous`;
  let moved = false;
  let published = false;
  try {
    for (const file of files) {
      const filename = resolve(stage, ...file.path.split('/'));
      const rel = relative(stage, filename);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Restore path escaped staging directory');
      await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
      await writeFile(filename, Buffer.from(file.content, 'base64'), { flag: 'wx', mode: 0o600 });
    }
    const database = new DatabaseSync(join(stage, 'neo.sqlite'), { readOnly: true });
    try {
      const rows = database.prepare('PRAGMA integrity_check').all();
      if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw new Error('Restored database failed integrity check');
    } finally { database.close(); }
    await writeFile(join(stage, 'backup-manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    if (current) { await rename(target, previous); moved = true; }
    try { await rename(stage, target); published = true; }
    catch (error) { if (moved) { await rename(previous, target); moved = false; } throw error; }
    return { dataDir: target, databaseFile: join(target, 'neo.sqlite'), files: files.length, format: manifest.format };
  } finally {
    // Both paths are minted siblings, never caller-supplied recursive-delete targets.
    for (const path of [stage, ...(moved && published ? [previous] : [])]) {
      if (dirname(path) !== dirname(target) || !path.startsWith(join(dirname(target), '.neo-restore-'))) throw new Error('Unsafe restore cleanup');
      await rm(path, { recursive: true, force: true });
    }
  }
}
