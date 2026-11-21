# 01 · Project Map: what each upstream gives us

Status: draft v0.2 · 2026-11-17 · researched from the GitHub repos listed below

> v0.2 changes: bot-hq is **adopted as first-party** code; one Neo App on **Astryx** replaces every upstream UI; computers are provider-agnostic; Hermes' learned-skill system is core. See [02 Architecture](02-architecture.md).

Neo Meta Harness (NMH) builds very little from scratch. Most of the code already exists in seven upstream projects. This document lists what each project already does, which of those features we use, where projects overlap, and where they connect to each other.

## 1. Component inventory

| # | Diagram box | Source repo (consumed directly; old `ubermensch-site` forks retired) | Lang | Role in NMH | Extension seam we use |
|---|---|---|---|---|---|
| 1 | Super agent | `deepseek-ai/dsh-superagent-prototype` | TS | Always-on orchestrator: Sources → Triggers → Eval → Tickets → Executor | A **DSH bundle**. New **Source** kinds (documented in cookbook 008), Cordis patch rows, worker preset patch |
| 2 | Permanent memory | `plastic-labs/honcho` (self-hosted) | Py | Super agent's long-term memory, user/agent modelling, dialectic recall | REST API + SDKs; `@honcho-ai/harness-plugin-core` (TS), `hermes-plugin-honcho`, OpenClaw Honcho plugin |
| 3 | Coding harness backend | `deepseek-ai/deepseek-harness` | TS | Agent runtime for coding: everything-is-a-plugin (Cordis) | Plugins, bundles, profiles, `cordis.patch.yml`, ACP profile, SDK JSON-RPC |
| 4 | Coding harness frontend | `pingdotgg/t3code` | TS | Desktop/web/phone control plane, threads, worktrees, git/PR | **Local ACP command provider** (`dsh --profile acp`), MCP server (`/mcp`) for outside agents, T3 Connect / Tailscale |
| 5 | Agent harness runtime | `NousResearch/hermes-agent` | Py | General agent: messaging gateway, skills learning loop, cron, subagents, many backends | `plugins/` (memory, platforms, model-providers, cron_providers, delegation…), skills, `acp_adapter`, gateway `/v1/responses` |
| 6 | Agent fleet UX | `nickvasilescu/bot-hq` | TS | **Adopted** into `packages/agents`, generalised to expose all of Hermes on any computer | First-party code (MIT, attribution kept); upstream reviewed monthly |
| 7 | OpenClaw capabilities | `openclaw/openclaw` | TS | Ideas only (no code, no runtime): SOUL.md, workspace memory files, dreaming, standing intents, 20+ channels, device nodes | Plugin SDK, ClawHub skills, agent-runtime harnesses, Honcho memory plugin |
| 8 | Agent memory (local) | `ubermensch-site/Hermes-Agents-Local-Memory` (**ours**) | Py | Fast local memory shared by all agents: SQLite + FTS, facts, cards, markdown export | We own it, so we change it directly: add an MCP server, a Honcho sync, soul files |
| 9 | Design system | `meta/astryx` | TS | One design for the whole Neo App (React 19 + StyleX, 150+ components, CSS-variable themes) | npm `@astryxdesign/*` + Neo theme |

We consume the **source repos directly**; the older `ubermensch-site/*` forks are no longer part of the build (decision 2026-11-17).

## 2. Feature map by layer

### 2.1 Super agent (dsh-superagent + Honcho + small model)
| Feature | Source | Status |
|---|---|---|
| Source → Trigger → Thread → Eval → Ticket → Assignment domain, idempotent, restart-safe | dsh-superagent `src/core` | ✅ reuse |
| Policy / allow-lists / Mandates (who may ask for work) | dsh-superagent `policy.ts`, doc 002 | ✅ reuse |
| GitHub Source (issues, PRs, reviews), Feishu Source | `src/sources/*` | ✅ reuse GitHub; Feishu off |
| Executor = DSH worker Sessions in own dirs, background jobs | `src/executor/dsh.ts` | ✅ reuse |
| Web panel ("what needs a person") | doc 005 | ✅ reuse |
| Built-in short memory (`core/memory.ts`) | dsh-superagent | ✅ reuse, then mirror to Honcho |
| **Telegram / Hermes-gateway Source, cron Source, T3 thread Source, bot-hq Source** | — | 🆕 build (cookbook pattern) |
| **Delegation to T3 Code threads and Hermes bots** | T3 `/mcp`, bot-hq `/mcp/<bot>` | 🆕 wire via MCP in the worker preset |
| **Permanent memory via Honcho** | harness-plugin-core | 🆕 `neo-dsh-honcho` plugin |
| **Small always-on router model** | — | 🆕 v1 = API model + decision logging; later a fine-tuned local model |

### 2.2 Coding harness (DeepSeek Harness + T3 Code)
| Feature | Source | Status |
|---|---|---|
| Agent loop, tools (fs, bash, pwsh, terminal, grep, goal, schedule, plan, ask_user, run_code) | dsh packages | ✅ reuse |
| Subagents, agent-team (experimental), worktrees, workflow, jobs | dsh | ✅ reuse |
| MCP client, browser-use (Playwright/CDP/Stagehand), computer-use (CUA) | dsh | ✅ reuse |
| Hooks protocol (Claude Code / Codex compatible), webhook-github, auto-review | dsh experimental | ✅ evaluate |
| AGENTS.md / CLAUDE.md instruction loading | `dsh-agent-instructions` | ✅ reuse (SOUL via this path) |
| Profiles: web, headless, sdk, acp, desktop | dsh bundles | ✅ reuse `acp` + `headless` |
| **No long-term memory package** | — | 🆕 `neo-dsh-memory` plugin |
| Multi-provider control plane, threads, checkpoints, worktree per thread, diff → commit → PR | t3code | ✅ reuse |
| Desktop, web, iOS, Android; remote via Tailscale / T3 Connect | t3code | ✅ reuse |
| DeepSeek Harness as provider (`dsh --profile acp`) | t3code ACP docs | ✅ config only |
| T3 MCP for outside agents (start/message threads, list providers) | t3code | ✅ lets the super agent drive coding |

### 2.3 Agent harness (Hermes + bot-hq + OpenClaw capabilities + local memory)
| Feature | Source | Status |
|---|---|---|
| Messaging gateway: Telegram, Discord, Slack, WhatsApp, Signal, Email, MS Graph, webhooks | Hermes `gateway/` | ✅ reuse |
| Learning loop: autonomous skill creation, self-improving skills, FTS session search | Hermes | ✅ reuse |
| Memory provider plugins (byterover, retaindb, Honcho) | Hermes `plugins/memory` | 🆕 add `neo_local_memory` provider |
| Cron, kanban, delegation/subagents, hosted rooms, teams pipeline | Hermes | ✅ reuse |
| 6 terminal backends (local, Docker, SSH, Modal, Daytona, Vercel) | Hermes | ✅ reuse |
| ACP adapter (Hermes as a T3 Code provider) | Hermes `acp_adapter/` | ✅ optional |
| Trajectory generation and compression (training data) | Hermes `batch_runner.py`, `trajectory_compressor.py` | ✅ reuse for the small model |
| Bot team UX: chat with steps, screen per bot, takeover, voice, routines, tasks, Library, approvals | bot-hq | ✅ adopt + generalise |
| **Bot Screen:** Xfce desktop per bot on any Linux host/sandbox, takeover | Hermes | ✅ first computer provider |
| **Computer use via cua-driver** (Win/macOS/Linux, background) | Hermes `plugins/computer_use` | ✅ `computer-local` |
| **Learned skills:** `skill_manage`, `/learn`, background review, curator, learning graph, ledger, provenance, Skills Hub (ClawHub, skills.sh, GitHub) | Hermes `agent/`, `tools/skill*` | ✅ core of skills fabric |
| 26 channel platforms (Telegram, WhatsApp, Signal, Slack, Teams, iMessage/BlueBubbles, Matrix, Email, SMS…) | Hermes `plugins/platforms` | ✅ all exposed |
| 40+ model providers, credential pools, subscription proxy | Hermes `plugins/model-providers` | ✅ Model Hub |
| Dashboard themes + UI/backend plugins | Hermes dashboard | ✅ backend plugins used as API seam; UI not used |
| Composio apps, xAI voice and X search, Orgo screens | bot-hq | ✅ become optional extensions |
| SOUL.md personality layer | OpenClaw concept (also Hermes `SOUL.md`) | 🆕 shared soul files, served by local memory |
| USER.md / MEMORY.md / daily notes `memory/YYYY-MM-DD.md` | OpenClaw | 🆕 adopt the convention in local memory export |
| Dreaming (background consolidation), standing intents, memory provenance | OpenClaw | 🆕 port as a local-memory job + Hermes plugin |
| 20+ channels (iMessage, Teams…), device nodes (camera, screen, Canvas, voice) | OpenClaw | ⏸ optional OpenClaw node, phase 3+ |

## 3. Overlaps (things we must not run twice)

| Capability | Candidates | NMH decision |
|---|---|---|
| General agent runtime | Hermes, OpenClaw | **Hermes is primary** (bot-hq is built on it). OpenClaw is a design reference plus an optional node for channels and devices Hermes lacks. |
| Coding agent runtime | DSH, Hermes, Claude Code/Codex in T3 | **DSH is primary** for Neo-owned work. T3 keeps Claude/Codex available as extra providers. |
| Scheduler | Hermes cron, bot-hq routines, DSH schedule, superagent passes | Bot routines **are** Hermes cron jobs. The super agent owns cross-system schedules through its cron Source. |
| Agent memory | Hermes MEMORY.md, OpenClaw workspace files, DSH (none), superagent `core/memory.ts`, local memory, Honcho | **Two layers only**: local memory (L1, all agents) and Honcho (L2, permanent). Runtime-native memory files become *views* exported from L1. |
| Multi-agent messaging | Hermes `message_agent`, bot-hq `send_to_bot`, superagent Tickets | Superagent Tickets for orchestrated work; bot-hq `send_to_bot` for chatty peer work. |
| UI | T3 Code, bot-hq web, DSH web, superagent panel, Hermes dashboard and desktop | **One Neo App on Astryx.** No upstream UI is embedded; T3's headless client runtime and the Hermes / DSH APIs are used behind it. |

## 4. bot-hq gap audit ("did bot-hq miss something?")

Each gap below is filled by design; see [02 Architecture §5](02-architecture.md#5-agents-service-adopted-bot-hq-generalised). P0 confirms the exact Hermes APIs.

From bot-hq's architecture doc, compared against Hermes' code tree. **Each item is a candidate, to be confirmed in Phase 0 (task P0-5).**

| Hermes capability | bot-hq today | Gap? |
|---|---|---|
| Memory provider plugins (Honcho, retaindb…) | Reads and deletes `MEMORY.md` / `USER.md` only | **Yes**: no provider-aware memory, no cross-bot memory |
| Hermes cron (`hermes cron`) | Own routines scheduler | Partial: duplicates the feature; Hermes cron jobs are invisible in the UI |
| `message_agent`, hosted rooms, kanban | Own `send_to_bot`, group chats, tasks | Partial: parallel systems, not synced |
| Bot Mode / profiles (one gateway, many profiles) | One gateway **per bot** (ports 8650+) | Design choice; costs RAM per bot |
| Subagent delegation settings | Not surfaced | Yes |
| Skills (learned skills, agentskills.io) | Not surfaced | **Yes**: no skills browser or editor |
| Session search, `/insights`, usage | Not surfaced | Yes |
| Terminal backends (Docker/SSH/Modal/Daytona) | Orgo only (`HQ_LOCAL=1` runs locally) | **Yes**: hard Orgo dependency for screens |
| Messaging platforms config | Left to the primary Hermes | Partial |
| ACP adapter | Not used | n/a |
| Exec approvals (Hermes) vs Composio write approvals | Composio approvals only | Check that Hermes exec approvals reach the UI |
| Max 4 bots (Orgo screen limit) | Hard limit | Yes, for scale |

## 5. Integration surfaces we depend on (these get contract tests)

| Surface | Provider | Consumer |
|---|---|---|
| ACP stdio (`dsh --profile acp`) | DSH | T3 Code |
| T3 MCP `/mcp` (threads, providers) | T3 Code | Super agent workers |
| bot-hq MCP `/mcp/<bot>` + HTTP `/api` + SSE | bot-hq | Super agent workers, Neo Console |
| Hermes gateway `/v1/responses` (OpenAI-style) | Hermes | bot-hq, super agent Source |
| Hermes memory-provider plugin API | Hermes | `neo_local_memory` |
| Cordis plugin / bundle / patch API | DSH | all `neo-dsh-*` plugins, superagent bundle |
| Superagent Source kind interface (`src/sources/kind.ts`) | dsh-superagent | Neo Sources |
| Honcho REST v3 + harness-plugin-core config | Honcho | `neo-dsh-honcho`, `hermes-plugin-honcho` |
| Local memory in-process oRPC `/x/memory-local` (+ MCP, new) | ours | every agent |
