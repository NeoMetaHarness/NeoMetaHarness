import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const child = spawnSync(process.execPath, [join(dir, 'p6-2.mjs')], {
  cwd: join(dir, '..'), stdio: 'inherit', env: { ...process.env, NMH_P67: '1' },
});
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
