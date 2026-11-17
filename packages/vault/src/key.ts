import { randomBytes, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export interface KeyProvider {
  getKey(): Promise<Buffer>;
}

/** Restricts a credential file to the current user. Windows uses the user's SID in its DACL. */
export async function restrictPrivatePath(path: string): Promise<void> {
  if (process.platform === 'win32') {
    const { stdout } = await execFile('whoami', ['/user', '/fo', 'csv', '/nh']);
    const sid = stdout.match(/S-\d+(?:-\d+)+/)?.[0];
    if (!sid) throw new Error('Cannot determine Windows user SID for private file ACL');
    await execFile('icacls', [path, '/inheritance:r', '/grant:r', '*' + sid + ':(F)']);
  } else {
    const { chmod } = await import('node:fs/promises');
    await chmod(path, (await lstat(path)).isDirectory() ? 0o700 : 0o600);
  }
}

async function checkPrivatePath(path: string, directory: boolean): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
    throw new Error('Vault key path must be an ordinary ' + (directory ? 'directory' : 'file'));
  }
  if (process.platform === 'win32') {
    // Reassert the owner-only DACL, including for a pre-existing key.
    await restrictPrivatePath(path);
  } else if ((info.mode & 0o077) !== 0) {
    throw new Error('Vault key path has insecure permissions: ' + path);
  }
}

/**
 * A per-install key file, used instead of a native keychain module.
 * Store it in a dedicated key directory (for example, data/vault-keys/master.key).
 */
export class KeyFileProvider implements KeyProvider {
  constructor(readonly filename: string) {
    if (!filename || !resolve(filename)) throw new Error('A master key filename is required');
  }

  async getKey(): Promise<Buffer> {
    const directory = dirname(resolve(this.filename));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await checkPrivatePath(directory, true);

    const filename = resolve(this.filename);
    let exists = true;
    try { await lstat(filename); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
      else throw error;
    }

    if (!exists) {
      const temporary = filename + '.' + randomUUID() + '.tmp';
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(randomBytes(32).toString('hex'), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await restrictPrivatePath(temporary);
        // Hard-link creation is atomic and fails if a competing process won.
        try { await link(temporary, filename); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      } finally {
        await unlink(temporary);
      }
    }

    await checkPrivatePath(filename, false);
    const text = await readFile(filename, 'utf8');
    if (!/^[a-f0-9]{64}$/.test(text)) throw new Error('Vault master key is invalid');
    return Buffer.from(text, 'hex');
  }
}