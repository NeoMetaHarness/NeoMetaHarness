#!/usr/bin/env node
// Generates machine/capabilities.json from extensions/*/neo.extension.json.
// Run: node scripts/capabilities.mjs        (rewrite the file)
//      node scripts/capabilities.mjs --check (exit 1 if the file is out of date; used by pnpm check)
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'machine/capabilities.json')

export function buildCapabilities() {
  const extensions = readdirSync(join(root, 'extensions'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, 'extensions', entry.name, 'neo.extension.json')))
    .map((entry) => {
      const manifest = `extensions/${entry.name}/neo.extension.json`
      const m = JSON.parse(readFileSync(join(root, manifest), 'utf8'))
      const kind = [m.kind ?? []].flat().sort()
      return {
        id: m.id,
        version: m.version,
        display_name: m.displayName,
        kind,
        runtime_type: m.runtime?.type,
        ...(m.dependsOn && Object.keys(m.dependsOn).length ? { dependsOn: m.dependsOn } : {}),
        manifest,
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  const kinds = {}
  for (const extension of extensions) for (const k of extension.kind) (kinds[k] ??= []).push(extension.id)
  return {
    schema_version: 1,
    source: 'extensions/*/neo.extension.json',
    generated_by: 'scripts/capabilities.mjs',
    note: 'Generated from the extension manifests; do not edit by hand. Lists id, version, name, kind, runtime type and dependsOn only (settings and contributes stay in the manifests). Kinds do not imply enabled, healthy or released status; readiness is tracked only in machine/readiness.json.',
    extension_count: extensions.length,
    kinds: Object.fromEntries(Object.entries(kinds).sort(([a], [b]) => a.localeCompare(b))),
    extensions,
  }
}

export const renderCapabilities = () => JSON.stringify(buildCapabilities(), null, 2) + '\n'

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = renderCapabilities()
  if (process.argv.includes('--check')) {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : ''
    if (current.replace(/\r\n/g, '\n') !== next) {
      console.error('machine/capabilities.json is out of date; run node scripts/capabilities.mjs')
      process.exit(1)
    }
  } else {
    writeFileSync(target, next)
    console.log(`machine/capabilities.json: ${JSON.parse(next).extension_count} extensions`)
  }
}
