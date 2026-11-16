#!/usr/bin/env node
// Generate local skeletons for every org repo in machine/repositories.json (BrowserHarness layout).
// Never overwrites an existing file. No GitHub calls.
//   node scripts/org/scaffold.mjs --out ../NeoMetaHarness-org [--only NeoMetaHarness-Skills]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const out = resolve(root, args.includes('--out') ? args[args.indexOf('--out') + 1] : '../NeoMetaHarness-org')
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
const { org, repositories } = JSON.parse(readFileSync(join(root, 'machine/repositories.json'), 'utf8'))
const today = new Date().toISOString().slice(0, 10)
let created = 0

function put(dir, rel, content) {
  const p = join(dir, rel)
  if (existsSync(p)) return
  mkdirSync(dirname(p), { recursive: true })
  if (content instanceof URL || content?.copyFrom) copyFileSync(content.copyFrom, p)
  else writeFileSync(p, content)
  created++
}
const json = (o) => JSON.stringify(o, null, 2) + '\n'

const router = `# ${org} Router\n\n| Need | Canonical repository |\n|---|---|\n` +
  repositories.map(r => `| ${r.need} | ${org}/${r.name} |`).join('\n') +
  `\n\nNever solve ownership ambiguity by duplicating truth. Route to the owner and link back.\n`

for (const r of repositories) {
  if (r.name === 'NeoMetaHarness' || (only && r.name !== only)) continue
  const dir = join(out, r.name)
  const rules = [...r.rules, 'Never store secrets, API keys, session tokens or private user data.']
  put(dir, 'README.md', `# ${r.name}\n\n${r.owns}.\n\nPart of the [${org}](https://github.com/${org}) org. See ROUTER.md in ${org}-Progress-Memory for where every truth lives.\n`)
  put(dir, 'AGENTS.md', `# AGENTS.md: ${r.name}\n\nOwns: ${r.owns}.\n\n${rules.map(x => `- ${x}`).join('\n')}\n\n## GitHub safety circuit breaker\nFollow \`docs/policies/GITHUB-SAFETY-GUARDRAILS.md\` and \`machine/github-guardrails.json\` (mode \`local_only_no_actions\`): no GitHub Actions, work and test locally, at most 20 GitHub writes per task, stop on 403/429 and ask a human.\n`)
  put(dir, 'machine/github-guardrails.json', { copyFrom: join(root, 'machine/github-guardrails.json') })
  put(dir, 'docs/policies/GITHUB-SAFETY-GUARDRAILS.md', { copyFrom: join(root, 'docs/policies/GITHUB-SAFETY-GUARDRAILS.md') })
  put(dir, 'templates/.gitkeep', '')

  if (r.name.endsWith('-Progress-Memory')) {
    put(dir, 'ROUTER.md', router)
    put(dir, 'SESSION-START.md', `# Session Start\n\nBefore doing work:\n1. Read \`machine/current-state.json\`, \`machine/current-task.json\`, \`machine/blockers.json\`, \`machine/workstreams.json\`.\n2. Use \`ROUTER.md\` to find the canonical owner, then read that repo's \`AGENTS.md\`.\n3. Verify external/current state before changing anything.\n4. Reuse an existing workflow or Skill when one fits.\n5. Execute, verify, capture evidence.\n6. Update Progress-Memory only after a verified state change.\n\nIf state is ambiguous, do not invent completion.\n`)
    put(dir, 'UPDATE-PROTOCOL.md', `# Update Protocol\n\nUpdate when verified events change: the current workstream/task, a blocker, release/deployment state, repository ownership, incident/security state, or material roadmap state. Not for every commit.\n\n1. Verify canonical/external state.\n2. Update the canonical owner.\n3. Update machine state here.\n4. Reconcile CURRENT.md.\n5. Add a handoff only when continuity requires it.\n\nHandoff minimum: verified state; completed work; files/PRs/SHAs; failed checks/blockers; constraints; one precise next action.\n`)
    put(dir, 'CURRENT.md', `# Current State\n\n> Updated ${today}. The machine record is \`machine/current-state.json\`.\n\nPhase P0 (foundation) of Neo Meta Harness. The product repo is \`${org}/NeoMetaHarness\`. Planning docs (architecture, PRD, roadmap, extension system, org structure, ADR 0001 Tauri) are complete.\n\n## Next action\nRun the P0-3 seam spikes (see machine/readiness.json in the product repo).\n`)
    put(dir, 'templates/HANDOFF.md', `# ${org} Handoff\n\n## Verified current state\n\n## Work completed\n\n## Material files / PRs / commits\n\n## Checks performed\n\n## Failures / blockers\n\n## Constraints / invariants\n\n## Exact next action\n`)
    put(dir, 'machine/current-state.json', json({ schema_version: 1, phase: 'P0-foundation', status: 'active', current_workstream: 'foundation', current_task_id: 'P0-1', canonical_product_repo: `${org}/NeoMetaHarness`, updated: today }))
    put(dir, 'machine/current-task.json', json({ schema_version: 1, id: 'P0-3', title: 'Seam spikes a-g', owner_repo: `${org}/NeoMetaHarness`, status: 'todo' }))
    put(dir, 'machine/blockers.json', json({ schema_version: 1, blockers: [] }))
    put(dir, 'machine/workstreams.json', json({ schema_version: 1, workstreams: ['foundation', 'kernel-app', 'agents', 'computers', 'memory-skills', 'coding', 'super-agent'] }))
    put(dir, 'machine/repositories.json', json({ schema_version: 1, source_of_truth: `${org}/NeoMetaHarness/machine/repositories.json`, note: 'Mirror pointer for session routing.' }))
  }
}
console.log(`scaffolded into ${out}: ${created} file(s) created (existing files untouched)`)
