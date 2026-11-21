# 06 · GitHub Org: NeoMetaHarness

Status: draft v0.1 · 2026-11-17 · modelled on the [BrowserHarness](https://github.com/BrowserHarness) org

## 1. Principles (inherited from BrowserHarness)
- **One owner per truth.** Each kind of truth has one canonical repo. Other repos link to it and never duplicate it (`ROUTER.md`).
- Every repo has `AGENTS.md` (rules for agents), `README.md`, `machine/*.json` (machine-readable state; it wins over prose), `templates/` and `docs/policies/`.
- **GitHub safety guardrails** (`machine/github-guardrails.json`, mode `local_only_no_actions`):
  - no GitHub Actions and no `.github/workflows/*`;
  - work and test locally, then push once per unit of work;
  - at most 20 GitHub writes per task, and approval to touch more than 3 repos;
  - stop on any 403/429 and ask a human;
  - agents never approve their own exceptions.
- Public org; `Knowledgebase` and `.github` stay private (as in BrowserHarness).

## 2. Repositories

| Repo | Owns | Notes |
|---|---|---|
| **NeoMetaHarness** | Product monorepo: App, Gateway, kernel, SDKs, official extensions, upstream registry, deploy, roadmap | The code |
| NeoMetaHarness-Extensions | Extension registry index, extension guidelines, review rubric, templates | New (extension-first product) |
| NeoMetaHarness-Skills | Published skill packs (agentskills.io), skills registry, promotion and eval rules | Mirrors BrowserHarness-Skills rules (candidate version → eval → rollback, autonomy ceiling) |
| NeoMetaHarness-Agent-Registry | Agent / bot templates, roles, teams, SOUL presets | |
| NeoMetaHarness-Workflows | Procedures and learned workflows | |
| NeoMetaHarness-Automation | Scheduled / triggered orchestration definitions (super-agent routines) | |
| NeoMetaHarness-design-system | Neo theme on Astryx, tokens, UX patterns, `@neometaharness/ui` guidance | Theme package published from here |
| NeoMetaHarness-Progress-Memory | Current task, blockers, handoffs, workstreams (`CURRENT.md`, `ROUTER.md`, `SESSION-START.md`) | Organisational continuity for agents and humans |
| NeoMetaHarness-Security-Trust | Threat model, permissions model, extension review, disclosure policy | |
| NeoMetaHarness-Docs | Public documentation site source | |
| NeoMetaHarness-Website | Commercial / landing site | |
| NeoMetaHarness.github.io | Thin Pages surface | |
| NeoMetaHarness-Brand | Identity, voice, assets | |
| NeoMetaHarness-Data-Analytics | Metrics, events, opt-in telemetry schema | |
| NeoMetaHarness-Monetization | Pricing / packaging (future hosted offering) | |
| NeoMetaHarness-Marketing · -Content | GTM, campaigns, content assets | |
| NeoMetaHarness-Competitor-Analysis · -AI-Tool-Intelligence | Ecosystem and upstream intelligence (feeds the upstream registry) | |
| NeoMetaHarness-Customer-Ops | Onboarding, support, feedback | |
| NeoMetaHarness-Knowledgebase *(private)* | Internal knowledge | |
| .github *(private)* | Org defaults, profile | |

## 3. Product monorepo layout (`NeoMetaHarness/NeoMetaHarness`)

```
apps/
  neo-app/      Neo App (React 19 + Astryx web + PWA) and Tauri 2 desktop shell (src-tauri)
  gateway/      Neo Gateway server (kernel + Neo API)
  docs/         Documentation site (Astryx + Vite static site)
  cli/          `neo` CLI (planned)
packages/
  kernel/       extension host (Cordis), manifests, lifecycle, permissions, vault, event bus
  contracts/    Neo API schema (typed RPC + events)
  sdk/          TS extension SDK (planned)          · sdk-python/  Python extension SDK (planned)
  ui/           @neometaharness/ui: Astryx + Neo patterns + slot runtime
  agents/       adopted bot-hq domain (bots, rooms, routines, tasks, library, approvals, voice)
  auth/         Better Auth integration, session management, workspace access
  computers/    computer abstraction layer, safety policies, provider interfaces
  db/           Kysely database schema, migrations, SQLite dialect (Postgres planned)
  egress/       outbound HTTPS guard: URL validation, private-network blocking, DNS-checked sockets, response caps
  vault/        secrets encryption, key management, scoped projections
extensions/     official extensions, each independently toggleable
  Built: backup, channels (includes WhatsApp plugin), coding-workflow, computer-docker, computer-fake,
    computer-headless-chrome, computer-hermes-screen, computer-local-sandbox, computer-local, computer-vnc,
    computers-mcp, engine-dsh (with built-in neo-memory, -soul, -report, -skills plugins),
    engine-hermes (with built-in memory-plugin 'neo'), engine-superagent, engine-t3, memory-honcho,
    memory-local, models-router-panda, models, sample-py, sample-ts, skills-registry
  Partly built in other extensions: soul, skills-fabric (P6-7 done)
  Planned: computer-orgo (task P3-10), voice-xai, apps-composio, x-search
upstream/       registry.yaml · upstream.lock.json · sources/ (pinned checkouts, gitignored)
contracts-tests/  one suite per engine seam (planned; tests/ currently holds toggle-safety)
deploy/         installers (win/mac/linux), docker compose, systemd
training/       decision traces, datasets, router-model training (later)
docs/           architecture, ADRs
machine/        repositories.json · capabilities.json · readiness.json · github-guardrails.json
AGENTS.md  ROADMAP.md  README.md
```
