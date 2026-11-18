import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const assets = fileURLToPath(new URL('./memory-plugin/', import.meta.url));

export interface MemoryBridge {
  binding(profile: string): Promise<{ endpoint: string; token: string; profile: string } | undefined>;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Hermes plugin seam: plugins/memory/__init__.py:148 and :217 at the pinned ref. */
export async function projectHermesMemory(bridge: MemoryBridge | undefined, profile: string, home: string): Promise<string | undefined> {
  const binding = await bridge?.binding(profile);
  const plugin = join(home, 'plugins', 'neo');
  const config = join(home, 'config.yaml');
  const existing = await readFile(config, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const document = YAML.parseDocument(existing || '{}');
  if (document.errors.length) throw new Error(`Invalid Hermes config for profile ${profile}`);
  if (binding) {
    await mkdir(plugin, { recursive: true });
    await Promise.all(['plugin.yaml', '__init__.py'].map((name) => copyFile(join(assets, name), join(plugin, name))));
    await writeAtomic(join(plugin, 'binding.json'), JSON.stringify(binding) + '\n');
    document.setIn(['memory', 'provider'], 'neo');
  } else {
    await rm(join(plugin, 'binding.json'), { force: true });
    if (document.getIn(['memory', 'provider']) === 'neo') document.deleteIn(['memory', 'provider']);
  }
  const next = String(document);
  if (next !== existing) await writeAtomic(config, next);
  return binding?.token;
}
