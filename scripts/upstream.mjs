#!/usr/bin/env node
// Upstream drift checker. Read-only against GitHub/npm; writes only the local lock file.
//   pnpm upstream:check                 report latest vs pinned (source repos, no forks)
//   pnpm upstream:check --write-lock    pin everything to what is current now
//   pnpm upstream:check --only <name>   one upstream
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = join(root, 'upstream.lock.json')
const args = process.argv.slice(2)
const writeLock = args.includes('--write-lock')
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
const json = args.includes('--json')
// Test-only source substitution. An incomplete fixture fails closed without touching the network.
const feed = process.env.NMH_UPSTREAM_FEED ? JSON.parse(readFileSync(process.env.NMH_UPSTREAM_FEED, 'utf8')) : null

const reg = parseYaml(readFileSync(join(root, 'upstream/registry.yaml'), 'utf8'))
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : { schema_version: 1, pins: {} }

// Read-only GET with one retry for transient network errors. A 403/429 stops the run (guardrail circuit breaker).
const gh = (path, attempt = 1) => {
  if (feed) {
    if (!Object.hasOwn(feed.github ?? {}, path)) throw new Error(`Fake upstream feed missing ${path}`)
    return feed.github[path]
  }
  try { return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })) }
  catch (e) {
    const err = String(e.stderr ?? '')
    if (/HTTP (403|429)/.test(err) && !/Not Found/.test(err)) {
      console.error(`GitHub circuit breaker: ${err.trim()}\nStopping. Record this error and get human approval before retrying.`)
      process.exit(2)
    }
    return attempt < 2 && !/HTTP 404/.test(err) ? gh(path, attempt + 1) : null
  }
}
const npmVersion = (pkg) => {
  if (feed) {
    if (!Object.hasOwn(feed.npm ?? {}, pkg)) throw new Error(`Fake upstream feed missing npm ${pkg}`)
    return feed.npm[pkg]
  }
  try { return execFileSync('npm', ['view', pkg, 'version'], { encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  catch { return null }
}

function resolveLatest(u) {
  if (u.channel === 'npm-latest' && u.package) {
    const v = npmVersion(u.package)
    if (v) return { kind: 'npm', ref: v, changelog: `https://github.com/${u.upstream}/releases` }
  }
  if (u.channel === 'stable-release') {
    const rel = gh(`repos/${u.upstream}/releases/latest`)
    if (rel?.tag_name) return { kind: 'release', ref: rel.tag_name, date: rel.published_at,
      changelog: rel.html_url ?? `https://github.com/${u.upstream}/releases` }
  }
  const repo = gh(`repos/${u.upstream}`)
  // List endpoint (one item) avoids the per-file payload of the single-commit endpoint.
  const commit = repo && gh(`repos/${u.upstream}/commits?sha=${repo.default_branch}&per_page=1`)?.[0]
  return commit ? { kind: 'commit', ref: commit.sha.slice(0, 12), date: commit.commit.committer.date,
    changelog: `https://github.com/${u.upstream}/commits/${repo.default_branch}` } : { kind: 'error', ref: 'unreachable' }
}

const rows = []
const entries = [
  ...Object.entries(reg.upstreams ?? {}),
  ...Object.entries(reg.adopted ?? {}).map(([n, a]) => [n, { ...a, channel: 'main', adopted: true }]),
].filter(([n]) => !only || n === only)

for (const [name, u] of entries) {
  const latest = resolveLatest(u)
  const pin = lock.pins[name]
  const status = latest.kind === 'error' ? 'ERROR' : !pin ? 'unpinned' : pin.ref === latest.ref ? 'current' : u.adopted ? 'review' : 'bump available'
  rows.push({ name, channel: u.channel, pinned: pin?.ref ?? '-', latest: latest.ref, status,
    upstream: u.upstream, changelog: latest.changelog ?? null })
  if (writeLock && latest.kind !== 'error') {
    // The verified download (commit, archive_sha256) belongs to one ref; a new ref must be re-verified by hand (P7-16).
    lock.pins[name] = { ...(pin?.ref === latest.ref ? pin : {}), kind: latest.kind, ref: latest.ref, upstream: u.upstream,
      pinned_on: new Date().toISOString().slice(0, 10) }
  }
}

if (json) console.log(`NMH_UPSTREAM_JSON=${JSON.stringify(rows)}`)
else console.table(rows)
if (writeLock) {
  lock.updated = new Date().toISOString()
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')
  console.log(`wrote ${Object.keys(lock.pins).length} pins to upstream.lock.json`)
}
