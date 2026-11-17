import { Ajv } from 'ajv';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import semver from 'semver';

export interface ExtensionManifest {
  id: string;
  version: string;
  displayName: string;
  dependsOn?: Record<string, string>;
  runtime:
    | { type: 'cordis'; entry: string }
    | { type: 'process'; command: string[]; protocol: 'jsonrpc' | 'jsonrpc+mcp' }
    | { type: 'ui-only' | 'content' };
}

const schema = JSON.parse(await readFile(new URL('./neo-extension.schema.json', import.meta.url), 'utf8'));
const validator = new Ajv({ allErrors: true }).compile(schema);

export async function loadManifest(directory: string): Promise<ExtensionManifest> {
  const path = resolve(directory, 'neo.extension.json');
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!validator(value)) throw new Error(`Invalid manifest ${path}: ${validator.errors?.map((error) => `${error.instancePath} ${error.message}`).join(', ')}`);
  const manifest = value as ExtensionManifest;
  if (!semver.valid(manifest.version)) throw new Error(`Invalid version for ${manifest.id}`);
  for (const range of Object.values(manifest.dependsOn ?? {})) {
    if (!semver.validRange(range)) throw new Error(`Invalid dependency version range in ${manifest.id}: ${range}`);
  }
  if (manifest.runtime.type === 'cordis') {
    const entry = resolve(directory, manifest.runtime.entry);
    const base = resolve(directory);
    if (!entry.startsWith(base + '\\') && !entry.startsWith(base + '/') && entry !== base) {
      throw new Error(`Extension entry escapes install root: ${manifest.id}`);
    }
  }
  return manifest;
}

export interface LocatedExtension {
  manifest: ExtensionManifest;
  directory: string;
}

/** Resolving all extensions detects cycles even when the cycle is disabled. */
export function resolveOrder(extensions: ReadonlyMap<string, LocatedExtension>): string[] {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: string[] = [];
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Extension dependency cycle: ${[...visiting, id].join(' -> ')}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of Object.keys(extensions.get(id)!.manifest.dependsOn ?? {})) {
      if (extensions.has(dependency)) visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
    result.push(id);
  };
  for (const id of extensions.keys()) visit(id);
  return result;
}

export function dependencyProblem(extension: ExtensionManifest, extensions: ReadonlyMap<string, LocatedExtension>): string | undefined {
  for (const [id, range] of Object.entries(extension.dependsOn ?? {})) {
    const dependency = extensions.get(id);
    if (!dependency) return `Missing dependency ${id}`;
    if (!semver.satisfies(dependency.manifest.version, range)) {
      return `Dependency ${id}@${dependency.manifest.version} does not satisfy ${range}`;
    }
  }
}
