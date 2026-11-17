import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { restrictPrivatePath } from './key.js';

export interface Projector<Result = unknown> {
  project(secrets: ReadonlyMap<string, string>): Promise<Result>;
}

const BEGIN = '# BEGIN NEO VAULT';
const END = '# END NEO VAULT';
const MANAGED_BLOCK = /^# BEGIN NEO VAULT\r?\n[\s\S]*?^# END NEO VAULT(?:\r?\n)?/gm;

const HERMES_KEYS = new Set([
  'API_SERVER_KEY', 'HERMES_DASHBOARD_SESSION_TOKEN',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY',
  'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY',
  'GROQ_API_KEY', 'XAI_API_KEY', 'TOGETHER_API_KEY',
  'MISTRAL_API_KEY', 'CEREBRAS_API_KEY', 'NVIDIA_API_KEY',
  'FIREWORKS_API_KEY', 'SAMBANOVA_API_KEY', 'MOONSHOT_API_KEY',
  'DASHSCOPE_API_KEY', 'ZAI_API_KEY', 'MINIMAX_API_KEY',
]);

function envValue(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('Environment values cannot contain newlines or NUL');
  return /^[a-zA-Z0-9_./:@+=-]+$/.test(value) ? value : JSON.stringify(value);
}

async function readExisting(filename: string): Promise<string> {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Hermes .env cannot be a symlink');
    return await readFile(filename, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** Each instance targets the .env at the explicitly supplied profile HERMES_HOME. */
export class HermesProjector implements Projector<void> {
  readonly filename: string;
  private readonly allowlist: ReadonlySet<string>;
  private readonly home: string;

  constructor(hermesHome: string, additionalProviderKeys: readonly string[] = []) {
    if (!isAbsolute(hermesHome)) throw new Error('Hermes profile HERMES_HOME must be absolute');
    this.home = resolve(hermesHome);
    this.filename = join(this.home, '.env');
    for (const key of additionalProviderKeys) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error('Invalid provider environment key');
    }
    this.allowlist = new Set([...HERMES_KEYS, ...additionalProviderKeys]);
  }

  async project(secrets: ReadonlyMap<string, string>): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const info = await lstat(this.home);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(this.home) !== this.home) {
      throw new Error('Hermes HERMES_HOME must be a real directory');
    }
    const existing = await readExisting(this.filename);
    const values = [...secrets].filter(([key]) => this.allowlist.has(key))
      .sort(([left], [right]) => left.localeCompare(right));
    const managed = values.map(([key, value]) => key + '=' + envValue(value));
    const matches = [...existing.matchAll(MANAGED_BLOCK)];
    const beginCount = existing.split(BEGIN).length - 1;
    const endCount = existing.split(END).length - 1;
    if (matches.length > 1 || matches.length !== beginCount || matches.length !== endCount) {
      throw new Error('Malformed Neo Vault markers in Hermes .env');
    }
    const block = managed.length ? [BEGIN, ...managed, END, ''].join('\n') : '';
    let updated: string;
    if (matches.length) {
      const match = matches[0]!;
      updated = existing.slice(0, match.index) + block + existing.slice(match.index! + match[0].length);
    } else if (managed.length) {
      updated = existing + (existing && !existing.endsWith('\n') ? '\n' : '') + block;
    } else {
      updated = existing;
    }
    if (updated === existing) return;

    const temporary = this.filename + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, updated, { flag: 'wx', mode: 0o600 });
      await restrictPrivatePath(temporary);
      await rename(temporary, this.filename);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}

/** Construct a process-spawn environment without spreading process.env. */
export class DshProjector implements Projector<Record<string, string>> {
  private readonly credentials: ReadonlySet<string>;

  constructor(credentialKeys: readonly string[] = ['DEEPSEEK_API_KEY', 'DSH_CONFIG_PATH']) {
    for (const key of credentialKeys) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error('Invalid DSH credential key');
    }
    this.credentials = new Set(credentialKeys);
  }

  async project(secrets: ReadonlyMap<string, string>): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    const runtimeKeys = new Set([
      'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
      'HOME', 'USERPROFILE',
    ]);
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && runtimeKeys.has(key.toUpperCase())) env[key] = value;
    }
    for (const [key, value] of secrets) {
      if (this.credentials.has(key)) env[key] = value;
    }
    return env;
  }
}