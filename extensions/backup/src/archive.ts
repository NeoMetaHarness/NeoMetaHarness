import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { lstat, readdir, readFile, writeFile, mkdir, mkdtemp, rm, open } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const MAGIC = Buffer.from('NEOBK001');
const LIMIT = 256 * 1024 * 1024;
const excluded = new Set(['node_modules', '.cache', 'cache', 'caches', '__pycache__', 'vault-keys']);
export interface BackupSource {
  snapshot(filename: string): Promise<void>;
  roots: { source: string; target: string }[];
  excludedPaths: string[];
  versions: Record<string, string>;
}
type Entry = { path: string; sha256: string; size: number; content: string };
export type Manifest = { format: 1; neo: '0.1.0'; createdAt: string; versions: Record<string, string>;
  database: 'neo.sqlite'; files: Omit<Entry, 'content'>[]; masterKeyIncluded: false };
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function key(passphrase: string, salt: Buffer): Buffer {
  if (typeof passphrase !== 'string' || passphrase.length < 12) throw new Error('Backup passphrase must have at least 12 characters');
  return scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}
function safePath(path: string): boolean {
  return typeof path === 'string' && path.length > 0 && !path.includes('\\') && !path.includes(':') &&
    !/[\x00-\x1f]/.test(path) && !isAbsolute(path) && path.split('/').every(p => p && p !== '.' && p !== '..' &&
      !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
}
function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
export async function createBackup(source: BackupSource, options: { out: string; passphrase: string }) {
  const salt = randomBytes(16), iv = randomBytes(12), archiveKey = key(options.passphrase, salt);
  const stage = await mkdtemp(join(tmpdir(), 'neo-backup-'));
  const files: Entry[] = [];
  let total = 0;
  const add = async (filename: string, path: string, snapshot = false) => {
    if (!safePath(path) || files.some(f => f.path.toLowerCase() === path.toLowerCase())) throw new Error('Invalid or duplicate backup path');
    const before = await lstat(filename);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('Backup refuses links and special files');
    total += before.size;
    if (total > LIMIT) throw new Error('Backup exceeds 256 MiB file limit');
    const handle = await open(filename, 'r');
    const header = Buffer.alloc(16);
    try { await handle.read(header, 0, 16, 0); } finally { await handle.close(); }
    const engineDatabase = !snapshot && header.equals(Buffer.from('SQLite format 3\0'));
    let data: Buffer;
    if (engineDatabase) {
      // Engine-owned SQLite homes also need an online snapshot, including WAL.
      const temporary = join(stage, `engine-${files.length}.sqlite`);
      const database = new DatabaseSync(filename, { readOnly: true });
      try { database.prepare('VACUUM INTO ?').run(temporary); }
      finally { database.close(); }
      data = await readFile(temporary);
      total += Math.max(0, data.length - before.size);
      if (total > LIMIT) throw new Error('Backup exceeds 256 MiB file limit');
    } else data = await readFile(filename);
    const after = await lstat(filename);
    if (!engineDatabase && (before.size !== after.size || before.mtimeMs !== after.mtimeMs)) throw new Error('File changed during backup; pause writers and retry');
    files.push({ path, sha256: sha256(data), size: data.length, content: data.toString('base64') });
  };
  const walk = async (root: string, target: string) => {
    if (source.excludedPaths.some(p => inside(p, root)) || resolve(root) === resolve(options.out)) return;
    const stat = await lstat(root).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error('Backup refuses symbolic links');
    if (stat.isDirectory()) {
      for (const item of (await readdir(root)).sort()) {
        if (excluded.has(item.toLowerCase()) || /^(master\.key|auth\.secret|desktop.*token)$/i.test(item) || /(-wal|-shm|\.lock)$/.test(item)) continue;
        await walk(join(root, item), `${target}/${item}`);
      }
    } else await add(root, target);
  };
  try {
    await source.snapshot(join(stage, 'neo.sqlite'));
    await add(join(stage, 'neo.sqlite'), 'neo.sqlite', true);
    for (const root of source.roots) await walk(root.source, root.target);
    const manifest: Manifest = { format: 1, neo: '0.1.0', createdAt: new Date().toISOString(), versions: source.versions,
      database: 'neo.sqlite', masterKeyIncluded: false, files: files.map(({ content, ...entry }) => entry) };
    const cipher = createCipheriv('aes-256-gcm', archiveKey, iv);
    cipher.setAAD(MAGIC);
    const encrypted = Buffer.concat([cipher.update(gzipSync(JSON.stringify({ manifest, files }))), cipher.final()]);
    await mkdir(dirname(resolve(options.out)), { recursive: true });
    // Exclusive creation avoids overwriting an existing archive or following a link.
    await writeFile(options.out, Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), encrypted]), { flag: 'wx', mode: 0o600 });
    return { out: resolve(options.out), files: files.length, format: 1 };
  } finally {
    archiveKey.fill(0);
    if (dirname(resolve(stage)) !== resolve(tmpdir()) || !resolve(stage).startsWith(join(resolve(tmpdir()), 'neo-backup-'))) throw new Error('Unsafe backup cleanup');
    await rm(stage, { recursive: true, force: true });
  }
}

export async function verifyArchive(filename: string, passphrase: string): Promise<{ manifest: Manifest; files: Entry[] }> {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.size > LIMIT * 2) throw new Error('Invalid archive size or type');
  const data = await readFile(filename);
  if (data.length < 52 || !data.subarray(0, 8).equals(MAGIC)) throw new Error('Unsupported backup format');
  const archiveKey = key(passphrase, data.subarray(8, 24));
  let payload: any;
  try {
    const cipher = createDecipheriv('aes-256-gcm', archiveKey, data.subarray(24, 36));
    cipher.setAAD(MAGIC);
    cipher.setAuthTag(data.subarray(36, 52));
    const compressed = Buffer.concat([cipher.update(data.subarray(52)), cipher.final()]);
    payload = JSON.parse(gunzipSync(compressed, { maxOutputLength: LIMIT * 2 }).toString('utf8'));
  } catch { throw new Error('Archive authentication or decoding failed'); }
  finally { archiveKey.fill(0); }
  const { manifest, files } = payload;
  if (manifest?.format !== 1 || manifest.neo !== '0.1.0' || manifest.database !== 'neo.sqlite' || manifest.masterKeyIncluded !== false ||
      !manifest.versions || typeof manifest.versions !== 'object' || Array.isArray(manifest.versions) ||
      Object.values(manifest.versions).some(v => typeof v !== 'string') ||
      !Array.isArray(files) || !Array.isArray(manifest.files) || files.length !== manifest.files.length) throw new Error('Unsupported manifest version or structure');
  const seen = new Set<string>();
  let total = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i], entry = manifest.files[i];
    if (!safePath(file.path) || (file.path !== 'neo.sqlite' && !file.path.startsWith('extensions/')) ||
        file.path.split('/').some((p: string) => excluded.has(p.toLowerCase()) || /^(master\.key|auth\.secret|desktop.*token)$/i.test(p)) ||
        seen.has(file.path.toLowerCase()) || typeof file.content !== 'string') throw new Error('Invalid archive path');
    seen.add(file.path.toLowerCase());
    const content = Buffer.from(file.content, 'base64');
    total += content.length;
    if (total > LIMIT || file.size !== content.length || file.sha256 !== sha256(content) ||
        entry?.path !== file.path || entry.size !== file.size || entry.sha256 !== file.sha256) throw new Error('Manifest checksum mismatch');
  }
  if (!seen.has('neo.sqlite')) throw new Error('Missing database');
  return { manifest, files };
}
