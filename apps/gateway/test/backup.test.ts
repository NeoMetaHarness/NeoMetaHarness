import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteDatabaseProvider } from '@neometaharness/db';
import { createBackup, verifyArchive } from '../../../extensions/backup/src/archive.js';
import { restoreBackup } from '../../../extensions/backup/src/restore.js';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { gzipSync } from 'node:zlib';

test('encrypted backup snapshots live WAL SQLite and excludes keys and caches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neo-backup-test-'));
  const db = new SqliteDatabaseProvider(join(root, 'live.sqlite'));
  let engine: DatabaseSync | undefined;
  try {
    db.sqlite.exec("PRAGMA journal_mode=WAL; CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('live WAL record');");
    const extensions = join(root, 'extensions');
    await mkdir(join(extensions, 'skills-registry', '.git'), { recursive: true });
    await mkdir(join(extensions, 'cache'), { recursive: true });
    await mkdir(join(extensions, 'engine-dsh'), { recursive: true });
    engine = new DatabaseSync(join(extensions, 'engine-dsh', 'state.sqlite'));
    engine.exec("PRAGMA journal_mode=WAL; CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('engine WAL record');");
    await writeFile(join(extensions, 'skills-registry', '.git', 'HEAD'), 'ref: refs/heads/main');
    await writeFile(join(extensions, 'cache', 'omit'), 'cache');
    await writeFile(join(extensions, 'master.key'), 'never archive');
    const archive = join(root, 'backup.neo');
    const source = { snapshot: async (file: string) => { db.sqlite.prepare('VACUUM INTO ?').run(file); },
      roots: [{ source: extensions, target: 'extensions' }], excludedPaths: [], versions: { test: '1' } };
    await createBackup(source, { out: archive, passphrase: 'test passphrase for archive' });
    const verified = await verifyArchive(archive, 'test passphrase for archive');
    assert.deepEqual(verified.files.map(f => f.path), ['neo.sqlite', 'extensions/engine-dsh/state.sqlite', 'extensions/skills-registry/.git/HEAD']);
    assert.equal(verified.manifest.masterKeyIncluded, false);
    assert.ok(!(await readFile(archive)).includes(Buffer.from('live WAL record')));
    const snapshot = join(root, 'snapshot.sqlite');
    await writeFile(snapshot, Buffer.from(verified.files[0].content, 'base64'));
    const restored = new SqliteDatabaseProvider(snapshot);
    try { assert.equal(restored.sqlite.prepare('SELECT value FROM proof').get()?.value, 'live WAL record'); }
    finally { restored.sqlite.close(); }
    await writeFile(snapshot, Buffer.from(verified.files[1].content, 'base64'));
    const engineSnapshot = new DatabaseSync(snapshot);
    try { assert.equal(engineSnapshot.prepare('SELECT value FROM proof').get()?.value, 'engine WAL record'); }
    finally { engineSnapshot.close(); }
    // Authenticated but incompatible/malformed fixtures exercise manifest validation,
    // independently of the encryption tampering check above.
    for (const kind of ['version', 'hash', 'path']) {
      const payload = structuredClone(verified);
      if (kind === 'version') (payload.manifest as any).neo = '99.0.0';
      if (kind === 'hash') payload.manifest.files[0].sha256 = '0'.repeat(64);
      if (kind === 'path') payload.files[0].path = '../escape.sqlite';
      const salt = randomBytes(16), nonce = randomBytes(12);
      const derived = scryptSync('test passphrase for archive', salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      const cipher = createCipheriv('aes-256-gcm', derived, nonce);
      cipher.setAAD(Buffer.from('NEOBK001'));
      const encrypted = Buffer.concat([cipher.update(gzipSync(JSON.stringify(payload))), cipher.final()]);
      const malformed = join(root, `${kind}.neo`);
      await writeFile(malformed, Buffer.concat([Buffer.from('NEOBK001'), salt, nonce, cipher.getAuthTag(), encrypted]));
      await assert.rejects(restoreBackup({ archive: malformed, dataDir: join(root, 'invalid'), passphrase: 'test passphrase for archive' }), /manifest|checksum|path/i);
    }
    await assert.rejects(verifyArchive(archive, 'incorrect passphrase'), /authentication/);
    const bytes = await readFile(archive); bytes[bytes.length - 1] ^= 1;
    await writeFile(join(root, 'tampered.neo'), bytes);
    await assert.rejects(verifyArchive(join(root, 'tampered.neo'), 'test passphrase for archive'), /authentication/);
    await assert.rejects(createBackup(source, { out: archive, passphrase: 'test passphrase for archive' }), /EEXIST/);
  } finally {
    engine?.close();
    db.sqlite.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'));
    await rm(root, { recursive: true, force: true });
  }
});

test('restore refuses non-empty and protected destinations, validates before force, then publishes a valid database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neo-restore-test-'));
  const db = new SqliteDatabaseProvider(join(root, 'live.sqlite'));
  try {
    db.sqlite.exec('CREATE TABLE proof(value TEXT)');
    const archive = join(root, 'backup.neo'), destination = join(root, 'restored');
    const passphrase = 'restore test passphrase';
    await createBackup({ snapshot: async file => { db.sqlite.prepare('VACUUM INTO ?').run(file); }, roots: [], excludedPaths: [], versions: {} }, { out: archive, passphrase });
    await mkdir(destination);
    await writeFile(join(destination, 'sentinel'), 'keep until valid restore');
    await assert.rejects(restoreBackup({ archive, dataDir: destination, passphrase }), /non-empty/);
    await assert.rejects(restoreBackup({ archive, dataDir: destination, passphrase, force: true }, [root]), /protected/);
    await assert.rejects(restoreBackup({ archive, dataDir: destination, passphrase: 'wrong passphrase', force: true }), /authentication/);
    assert.equal(await readFile(join(destination, 'sentinel'), 'utf8'), 'keep until valid restore');
    const result = await restoreBackup({ archive, dataDir: destination, passphrase, force: true });
    assert.equal(result.databaseFile, join(destination, 'neo.sqlite'));
    assert.equal(JSON.parse(await readFile(join(destination, 'backup-manifest.json'), 'utf8')).format, 1);
    assert.equal(result.files, 1);
  } finally {
    db.sqlite.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'));
    await rm(root, { recursive: true, force: true });
  }
});
