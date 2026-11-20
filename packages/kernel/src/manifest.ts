import { Ajv } from 'ajv';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import semver from 'semver';

export type SettingPropertyType = 'string' | 'number' | 'integer' | 'boolean';

export interface SettingPropertySchema {
  type?: SettingPropertyType;
  enum?: (string | number)[];
  title?: string;
  description?: string;
  default?: string | number | boolean;
  secret?: boolean;
  minimum?: number;
  maximum?: number;
}

export interface ExtensionSettingsSchema {
  [key: string]: unknown;
  type?: 'object';
  properties: Record<string, SettingPropertySchema>;
  required?: string[];
}

export interface ExtensionManifest {
  id: string;
  version: string;
  displayName: string;
  dependsOn?: Record<string, string>;
  runtime:
    | { type: 'cordis'; entry: string }
    | { type: 'process'; command: string[]; protocol: 'jsonrpc' | 'jsonrpc+mcp'; routeTimeoutMs?: Record<string, number> }
    | { type: 'ui-only' | 'content' };
  settings?: ExtensionSettingsSchema;
}

export function validateSettings(id: string, settings: unknown): ExtensionSettingsSchema {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error(`Invalid settings schema for ${id}: settings must be an object`);
  }
  const s = settings as Record<string, unknown>;
  if (s.type !== undefined && s.type !== 'object') {
    throw new Error(`Invalid settings schema for ${id}: root type must be object`);
  }
  if (!s.properties || typeof s.properties !== 'object' || s.properties === null || Array.isArray(s.properties)) {
    throw new Error(`Invalid settings schema for ${id}: properties must be an object`);
  }
  const properties = s.properties as Record<string, unknown>;
  for (const [key, prop] of Object.entries(properties)) {
    if (typeof prop !== 'object' || prop === null || Array.isArray(prop)) {
      throw new Error(`Invalid settings property '${key}' in ${id}`);
    }
    const p = prop as Record<string, unknown>;
    if (!p.type && !p.enum) {
      throw new Error(`Invalid settings property '${key}' in ${id}: must specify type or enum`);
    }
    if (p.type !== undefined && !['string', 'number', 'integer', 'boolean'].includes(p.type as string)) {
      throw new Error(`Invalid settings property '${key}' in ${id}: unsupported type '${p.type}'`);
    }
    if (p.enum !== undefined && (!Array.isArray(p.enum) || p.enum.length === 0)) {
      throw new Error(`Invalid settings property '${key}' in ${id}: enum must be a non-empty array`);
    }
    if (p.secret !== undefined && typeof p.secret !== 'boolean') {
      throw new Error(`Invalid settings property '${key}' in ${id}: secret must be boolean`);
    }
  }
  return settings as ExtensionSettingsSchema;
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
  if (manifest.settings) {
    validateSettings(manifest.id, manifest.settings);
  }
  return manifest;
}

export interface LocatedExtension {
  manifest: ExtensionManifest;
  directory: string;
  managed?: true;
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

/** A settings value the schema refuses; the Gateway reports it as a bad request. */
export class SettingsValidationError extends Error {}

/**
 * Validate (and lightly coerce) values against an extension's settings schema before they are stored.
 * - Unknown keys and wrong types are refused: the string "false" is not a boolean, "abc" is not a number.
 * - Numbers and integers also accept a numeric string ("10" becomes 10); integers must be whole.
 * - enum, minimum and maximum are enforced.
 * - null clears a stored value (the default applies again). A secret takes a string; '' leaves it unchanged.
 * Returns the values to write; null marks a key to clear.
 */
export function coerceSettingValues(id: string, schema: ExtensionSettingsSchema | undefined,
  values: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const fail = (key: string, problem: string): never => {
    throw new SettingsValidationError(`Invalid setting '${key}' for ${id}: ${problem}`);
  };
  for (const [key, raw] of Object.entries(values)) {
    const property = schema?.properties?.[key];
    if (!property) fail(key, 'not declared in the settings schema');
    if (raw === null) { result[key] = null; continue; }
    if (property!.secret) {
      if (typeof raw !== 'string') fail(key, 'a secret must be a string');
      if (raw !== '') result[key] = raw;
      continue;
    }
    let value: unknown = raw;
    switch (property!.type) {
      case 'boolean':
        if (typeof value !== 'boolean') fail(key, `expected a boolean, got ${JSON.stringify(raw)}`);
        break;
      case 'number':
      case 'integer':
        if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) value = Number(value);
        if (typeof value !== 'number' || !Number.isFinite(value)) fail(key, `expected a number, got ${JSON.stringify(raw)}`);
        if (property!.type === 'integer' && !Number.isInteger(value)) fail(key, 'expected a whole number');
        if (property!.minimum !== undefined && (value as number) < property!.minimum) fail(key, `below the minimum ${property!.minimum}`);
        if (property!.maximum !== undefined && (value as number) > property!.maximum) fail(key, `above the maximum ${property!.maximum}`);
        break;
      case 'string':
        if (typeof value !== 'string') fail(key, `expected a string, got ${JSON.stringify(raw)}`);
        break;
      default:
        break;
    }
    if (property!.enum && !property!.enum.includes(value as string | number)) fail(key, `must be one of ${JSON.stringify(property!.enum)}`);
    result[key] = value;
  }
  return result;
}
