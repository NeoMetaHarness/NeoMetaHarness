import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import type { SqliteDatabaseProvider } from '@neometaharness/db';
import type { BackupSource } from '../../../extensions/backup/src/archive.js';

/** Only Neo-owned storage is inventoried. External engine URLs/homes are never traversed. */
export function backupSource(db: SqliteDatabaseProvider, extensionDataDir: string, vaultKeyFile: string): BackupSource {
  const hermesHome = join(extensionDataDir, 'engine-hermes', 'home');
  const legacyHome = fileURLToPath(new URL('../../../extensions/engine-hermes/.cache/home', import.meta.url));
  const versions: Record<string, string> = { neo: '0.1.0', node: process.versions.node };
  const lock = JSON.parse(readFileSync(new URL('../../../upstream.lock.json', import.meta.url), 'utf8'));
  for (const [name, pin] of Object.entries(lock.pins)) versions[`upstream:${name}`] = (pin as { ref: string }).ref;
  return {
    snapshot: async filename => { db.sqlite.prepare('VACUUM INTO ?').run(filename); },
    roots: [
      { source: extensionDataDir, target: 'extensions' },
      ...(!process.env.NMH_HERMES_HOME && !existsSync(hermesHome) ? [{ source: legacyHome, target: 'extensions/engine-hermes/home' }] : []),
    ],
    excludedPaths: [resolve(vaultKeyFile)],
    versions,
  };
}
