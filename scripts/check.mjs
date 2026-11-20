#!/usr/bin/env node
// Local check pipeline (no CI by policy). Run: pnpm check
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { checkPerfBudgets } from './perf-budgets.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const fail = (check, msg) => failures.push(`[${check}] ${msg}`)

function walk(dir, pred, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'sources') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, pred, out)
    else if (pred(p)) out.push(p)
  }
  return out
}

// 1. Guardrails: no GitHub workflows, ever.
const guard = JSON.parse(readFileSync(join(root, 'machine/github-guardrails.json'), 'utf8'))
if (guard.mode !== 'local_only_no_actions') fail('guardrails', `unexpected mode ${guard.mode}`)
if (existsSync(join(root, '.github/workflows'))) fail('guardrails', '.github/workflows exists; GitHub Actions are not allowed')

// 2. Machine state is valid JSON with a schema_version.
for (const f of walk(join(root, 'machine'), p => p.endsWith('.json'))) {
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'))
    if (typeof j.schema_version !== 'number') fail('machine', `${relative(root, f)} has no schema_version`)
  } catch (e) { fail('machine', `${relative(root, f)}: ${e.message}`) }
}

// 3. Relative markdown links resolve.
for (const f of walk(root, p => p.endsWith('.md'))) {
  const text = readFileSync(f, 'utf8').replace(/```[\s\S]*?```/g, '')
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:|#)/.test(target)) continue
    const path = decodeURIComponent(target.split('#')[0])
    if (path && !existsSync(resolve(dirname(f), path))) fail('links', `${relative(root, f)} → ${target}`)
  }
}

// 4. Upstream registry schema.
const reg = parseYaml(readFileSync(join(root, 'upstream/registry.yaml'), 'utf8'))
for (const [name, u] of Object.entries(reg.upstreams ?? {})) {
  for (const k of ['upstream', 'lang', 'channel', 'bump', 'role', 'seams'])
    if (u[k] === undefined) fail('registry', `${name} missing ${k}`)
  if (!['nightly', 'weekly'].includes(u.bump)) fail('registry', `${name} bump must be nightly|weekly`)
  if (!['stable-release', 'main', 'npm-latest'].includes(u.channel)) fail('registry', `${name} unknown channel ${u.channel}`)
}
for (const [name, a] of Object.entries(reg.adopted ?? {}))
  if (!a.upstream || !a.into) fail('registry', `adopted ${name} needs upstream and into`)

// 5. Repositories list is consistent with the product repo.
const repos = JSON.parse(readFileSync(join(root, 'machine/repositories.json'), 'utf8')).repositories
if (!repos.some(r => r.name === 'NeoMetaHarness')) fail('repos', 'product repo missing from machine/repositories.json')
const dup = repos.map(r => r.name).filter((n, i, a) => a.indexOf(n) !== i)
if (dup.length) fail('repos', `duplicate names: ${dup.join(', ')}`)

// 6. Performance budgets: built bundle gzip sizes and docs site size.
const perf = checkPerfBudgets({ root })
for (const problem of perf.failures) {
  fail('perf-budgets', problem)
}

if (failures.length) {
  console.error(`neo check: ${failures.length} problem(s)\n` + failures.map(f => '  ✗ ' + f).join('\n'))
  process.exit(1)
}
console.log('neo check: all checks passed (guardrails, machine, links, registry, repos, perf-budgets)')
