import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import semver from 'semver';
import { loadManifest, type LocatedExtension } from './manifest.js';

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
}

async function checkedLink(root: string, path: string): Promise<string> {
  const target = await readlink(path);
  if (isAbsolute(target) || !inside(root, resolve(dirname(path), target)) || !inside(root, await realpath(path))) {
    throw new Error(`Symlink escapes extension tree: ${relative(root, path)}`);
  }
  return target;
}

/** SHA-256 of the JSON array of path-sorted [path, type, ...metadata] records. */
export async function extensionIntegrity(directory: string): Promise<string> {
  const root = await realpath(directory);
  const records = new Map<string, unknown[]>();
  async function walk(parent: string, prefix: string) {
    for (const name of await readdir(parent)) {
      const path = join(parent, name);
      const key = prefix + name;
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await checkedLink(root, path);
        records.set(key, [key, 'link', target.split(sep).join('/')]);
      } else if (info.isDirectory()) {
        records.set(key, [key, 'directory']);
        await walk(path, key + '/');
      } else if (info.isFile()) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(path)) hash.update(chunk);
        records.set(key, [key, 'file', info.mode & 0o111, hash.digest('hex')]);
      } else throw new Error(`Unsupported extension file: ${key}`);
    }
  }
  await walk(root, '');
  return createHash('sha256').update(JSON.stringify([...records.keys()].sort().map(key => records.get(key)))).digest('hex');
}

async function checkedManifest(directory: string, integrity: string) {
  if (!/^[a-f0-9]{64}$/i.test(integrity) || await extensionIntegrity(directory) !== integrity.toLowerCase()) {
    throw new Error('Extension integrity mismatch');
  }
  const manifest = await loadManifest(directory);
  if (manifest.runtime.type === 'process') {
    const executable = manifest.runtime.command[0]!;
    if (/[/\\:]/.test(executable) &&
        (isAbsolute(executable) || /^[a-z]:/i.test(executable) || !inside(directory, resolve(directory, executable)))) {
      throw new Error('Extension executable escapes install root');
    }
  }
  return manifest;
}

export class ExtensionInstalls {
  constructor(private readonly dataDir?: string) {}

  private async root() {
    if (!this.dataDir) throw new Error('Kernel extension storage is unavailable');
    const storage = join(await realpath(this.dataDir), 'extensions');
    const root = join(storage, 'generations');
    for (const directory of [storage, root]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (await realpath(directory) !== directory) throw new Error('Kernel generation storage is redirected');
    }
    return root;
  }

  async restore(installed: { id: string; directory: string; version: string; integrity: string | null }): Promise<LocatedExtension> {
    const { id, version, integrity } = installed;
    if (!/^[a-z][a-z0-9.-]*$/.test(id) || !semver.valid(version) || !integrity) throw new Error('Install identity or integrity is missing');
    const directory = join(await this.root(), `${id}@${version}`);
    if (resolve(installed.directory) !== directory || await realpath(directory) !== directory) {
      throw new Error('Install is outside kernel generation storage');
    }
    const manifest = await checkedManifest(directory, integrity);
    if (manifest.id !== id || manifest.version !== version) throw new Error('Installed manifest identity changed');
    return { directory, manifest };
  }

  async copy(id: string, source: string, integrity: string, previous: LocatedExtension): Promise<LocatedExtension> {
    if (!isAbsolute(source)) throw new Error('Upgrade directory must be absolute');
    if (!/^[a-f0-9]{64}$/i.test(integrity)) throw new Error('Extension integrity must be a SHA-256 hex digest');
    source = await realpath(source);
    const root = await this.root();
    if (inside(root, source) || inside(source, root) || source === previous.directory) {
      throw new Error('Upgrade requires a separate candidate directory');
    }
    const staging = await mkdtemp(join(root, '.staged-'));
    try {
      const copy = join(staging, 'tree');
      await cp(source, copy, {
        recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true,
        async filter(path) {
          if ((await lstat(path)).isSymbolicLink()) await checkedLink(source, path);
          return true;
        },
      });
      const manifest = await checkedManifest(copy, integrity);
      if (manifest.id !== id || !semver.gt(manifest.version, previous.manifest.version)) {
        throw new Error('Upgrade requires the same id and a newer version');
      }
      const directory = join(root, `${id}@${manifest.version}`);
      // Never overwrite code already present at a generation path.
      const exists = await lstat(directory).then(() => true, error => {
        if (error.code !== 'ENOENT') throw error;
        return false;
      });
      if (exists) {
        await this.restore({ id, version: manifest.version, directory, integrity });
      } else await rename(copy, directory);
      return { directory, manifest };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
