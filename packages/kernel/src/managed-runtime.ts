import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { chmod, lstat, readdir, realpath, stat } from 'node:fs/promises';
import * as moduleApi from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export function isInside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
}

async function localPath(directory: string, input: string): Promise<string> {
  if (!input || /^[-\\/]/.test(input) || /[:\0]/.test(input)) {
    throw new Error(`Managed runtime requires a relative in-tree path: ${input}`);
  }
  const path = resolve(directory, input);
  if (!isInside(directory, path)) throw new Error(`Managed runtime path escapes generation: ${input}`);
  const resolved = await realpath(path);
  if (!isInside(directory, resolved)) throw new Error(`Managed runtime path escapes generation: ${input}`);
  return resolved;
}

export async function managedProcessCommand(directory: string, command: string[], pythonExecutable?: string): Promise<string[]> {
  const [interpreter, script, ...args] = command;
  if (interpreter !== 'node' && interpreter !== 'python') {
    throw new Error('Managed process interpreter must be node or python. PATH lookup is disabled');
  }
  if (!script) throw new Error('Managed process requires an in-tree script');
  const entry = await localPath(directory, script);
  const allowed = interpreter === 'node' ? ['.js', '.mjs', '.cjs'] : ['.py'];
  if (!allowed.includes(extname(entry)) || !(await stat(entry)).isFile()) throw new Error('Invalid managed process script');
  const paths = await Promise.all(args.map(arg => localPath(directory, arg)));
  if (interpreter === 'node') return [process.execPath, entry, ...paths];
  if (!pythonExecutable || !isAbsolute(pythonExecutable)) {
    throw new Error('Managed Python requires an absolute NMH_EXTENSION_PYTHON configured by the Gateway operator');
  }
  const python = await realpath(pythonExecutable);
  if (!(await stat(python)).isFile() || isInside(directory, python)) throw new Error('Invalid Gateway Python executable');
  return [python, '-E', '-S', '-B', entry, ...paths];
}

const cordisRoots = new Set<string>();
let hookInstalled = false;

export async function managedCordisEntry(directory: string, entry: string): Promise<string> {
  if (!moduleApi.registerHooks) throw new Error('Managed Cordis requires Node with synchronous module hooks (22.15+ or 23.5+)');
  const path = await localPath(directory, entry);
  if (!['.js', '.mjs', '.cjs'].includes(extname(path)) || !(await stat(path)).isFile()) {
    throw new Error('Managed Cordis requires a JavaScript entry');
  }
  return path;
}

export function pinCordisResolution(directory: string): void {
  cordisRoots.add(directory);
  if (hookInstalled) return;
  moduleApi.registerHooks({
    resolve(specifier, context, next) {
      const parent = context.parentURL?.startsWith('file:') ? fileURLToPath(context.parentURL) : undefined;
      const root = parent && [...cordisRoots].find(candidate => isInside(candidate, parent));
      const result = next(specifier, context);
      if (root && !result.url.startsWith('node:') &&
          (!result.url.startsWith('file:') || !isInside(root, realpathSync(fileURLToPath(result.url))))) {
        throw new Error(`Managed Cordis import escapes generation: ${specifier}`);
      }
      return result;
    },
  });
  hookInstalled = true;
}

const exec = promisify(execFile);

export async function sealGeneration(directory: string): Promise<void> {
  if (process.platform === 'win32') {
    // Windows directory attributes do not restrict creation. Use an inheritable
    // ACL so the serving identity has read and execute access throughout the copy.
    await exec(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-Command', `
        $ErrorActionPreference = 'Stop'
        $path = $env:NMH_GENERATION_DIR
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
          $identity, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
        [IO.Directory]::SetAccessControl($path, $acl)
      `,
    ], { env: { ...process.env, NMH_GENERATION_DIR: directory }, windowsHide: true, timeout: 10000 });
    return;
  }
  async function seal(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await seal(join(path, name));
      await chmod(path, 0o555);
    } else await chmod(path, 0o444 | (info.mode & 0o111));
  }
  await seal(directory);
}
