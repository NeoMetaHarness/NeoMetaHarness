import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { ComputerRegistry } from './index.js';

const assets = fileURLToPath(new URL('./hermes-plugin/', import.meta.url));

/** Projects a profile's assigned computer exclusively into the supplied Neo-owned home. */
export async function projectHermesComputer(registry: ComputerRegistry, profile: string, home: string, workspaceId?: string): Promise<string | undefined> {
  const binding = registry.binding('hermes', profile, workspaceId);
  const pluginDir = join(home, 'plugins', 'neo_vnc');
  if (!binding) {
    // Fail closed after release or unassignment. The retained backend config
    // cannot silently revert to acting on the user's real desktop.
    await rm(join(pluginDir, 'binding.json'), { force: true });
    return undefined;
  }
  await mkdir(pluginDir, { recursive: true });
  await Promise.all(['plugin.yaml', '__init__.py'].map((name) =>
    copyFile(join(assets, name), join(pluginDir, name))));

  const configFile = join(home, 'config.yaml');
  const existing = await readFile(configFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const document = YAML.parseDocument(existing || '{}');
  if (document.errors.length) throw new Error(`Invalid Hermes configuration for ${profile}`);
  document.setIn(['computer_use', 'backend'], 'neo_vnc');
  // Hermes's API-server toolset omits computer_use by default. The provider
  // can only run when it is also enabled in the profile's platform toolsets.
  const configured = document.getIn(['platform_toolsets', 'api_server']);
  if (configured === undefined || configured === null) {
    document.setIn(['platform_toolsets', 'api_server'], ['hermes-api-server', 'computer_use']);
  } else {
    const names = Array.isArray(configured) ? configured :
      YAML.isSeq(configured) ? configured.toJSON() : [];
    if (!names.includes('computer_use')) {
      document.setIn(['platform_toolsets', 'api_server'], [...names, 'computer_use']);
    }
  }
  const nextConfig = String(document);
  if (existing !== nextConfig) await atomicWrite(configFile, nextConfig);
  await atomicWrite(join(pluginDir, 'binding.json'), JSON.stringify(binding) + '\n');
  return binding.token;
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    const { rm } = await import('node:fs/promises');
    await rm(temporary, { force: true });
    throw error;
  }
}
