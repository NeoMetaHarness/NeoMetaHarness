import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { restoreBackup } from '../../../extensions/backup/src/restore.js';

const { values } = parseArgs({ options: { archive: { type: 'string' }, 'data-dir': { type: 'string' }, force: { type: 'boolean' } } });
try {
  if (!values.archive || !values['data-dir']) throw new Error('--archive and --data-dir are required');
  const passphrase = readFileSync(process.env.NEO_BACKUP_PASSPHRASE_FILE ?? 0, 'utf8').trimEnd();
  const cwd = process.env.INIT_CWD ?? process.cwd();
  console.log(JSON.stringify(await restoreBackup({ archive: resolve(cwd, values.archive), dataDir: resolve(cwd, values['data-dir']), passphrase, force: values.force }, [resolve(cwd)])));
} catch (error) { console.error(error instanceof Error ? error.message : 'Restore failed'); process.exitCode = 1; }
