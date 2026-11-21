# 03 · PRD: Neo Meta Harness

Status: draft v0.2 · 2026-11-17 · supersedes v0.1

## 1. Problem
The best open agent systems each solve one slice of the problem:
- DeepSeek Harness and dsh-superagent: orchestration and runtime;
- Hermes: agents, skills and channels;
- T3 Code: coding control;
- bot-hq: a friendly bot team;
- Honcho: memory.

Using them together means five UIs with five designs, separate memories, no agent in charge, lock-in to particular computers or models, and forks that drift behind fast-moving upstreams.

## 2. Product vision
**Neo Meta Harness is one open-source product. An always-on super agent knows you, runs a team of agents on any computer, through any channel, with any model. It learns new skills over time. Everything is an extension, and the whole thing looks and feels like one app.**

Built on giants: the **backends** of DeepSeek Harness and Hermes, and the **usability** of T3 Code and bot-hq, on **Astryx** design.

## 3. Product principles
1. One product feel: one Astryx design, one App, one settings model.
2. Everything is an extension; anything can be switched off.
3. Agnostic: models, subscriptions, channels, computers, memory, databases, engines.
4. Low attention cost: the agent acts when asked or when a rule allows, and only interrupts when a person must act.
5. Learns: skills improve with use; the super agent improves from its own outcomes.
6. Upstream-safe: engines unmodified, pinned, tested before each bump.
7. Local-first and open: MIT, self-hosted, your data on your machines.

## 4. Users
- **Builder / owner (primary):** runs Neo on their own machines and works from desktop and phone.
- **Small team:** shares a workspace with roles, bots and projects.
- **Extension developer:** builds and publishes extensions and skills.

## 5. Scope v1.0

### 5.1 Neo App (one UI)
| ID | Requirement | P |
|---|---|---|
| APP-1 | One Astryx-based App: web, installable PWA (phone), Tauri 2 desktop (Win/macOS/Linux) with gateway sidecar ([ADR 0001](adr/0001-desktop-shell.md)) | P0 |
| APP-7 | Performance budget: streaming-chat bench (PandaCode W1 method): script time ≤ 2× PandaCode; desktop installer ≤ 40 MB without sidecar | P0 |
| APP-2 | Sections: **Inbox** (what needs you), **Agents**, **Coding**, **Routines**, **Tasks**, **Computers**, **Skills**, **Memory**, **Extensions**, **Settings** (with sub-pages for Channels and Models) | P0 |
| APP-3 | "Ask Neo" bar everywhere → super agent | P0 |
| APP-4 | Onboarding wizard: role/topology, models and subscriptions, channels (choose any), computers, first bots | P0 |
| APP-5 | Light/dark + Neo theme on Astryx; extension themes | P1 |
| APP-6 | Command palette; keyboard-first | P1 |

### 5.2 Super agent
| ID | Requirement | P |
|---|---|---|
| SA-1 | Always-on orchestrator from the dsh-superagent bundle; restart-safe, idempotent | P0 |
| SA-2 | Takes work from any enabled channel, GitHub, the App, cron, and bot escalations | P0 |
| SA-3 | Policy: who may ask for what (per member identity); approvals for risky actions | P0 |
| SA-4 | Delegates to coding (T3 threads), bots (agents service), or does it itself; tracks to completion | P0 |
| SA-5 | Permanent memory in Honcho; dialectic recall | P0 |
| SA-6 | **Learns:** ticket post-mortem → candidate skills / playbooks → eval → promote | P0 |
| SA-7 | Router model from the Model Hub; every decision logged with its outcome | P0 |
| SA-9 | Report / assessment contracts across all executors; Inbox lanes from ticket stages | P0 |
| SA-10 | Accept modes `observe` / `act-with-approval` / `act` (workspace-level today; per-source or per-project planned); Suggestions lane | P0 |
| SA-11 | Sources: `@neo` code comments, failing checks | P1 |
| SA-8 | Small local router model (shadow → canary → primary) | P2 (post-v1) |

### 5.3 Agents (bot-hq adopted, all of Hermes exposed)
| ID | Requirement | P |
|---|---|---|
| AG-1 | Bots with name, look, SOUL, model route, memory provider, computer, channels | P0 |
| AG-2 | Chat that shows the work (live steps, "worked for" chips), approvals, Library | P0 |
| AG-3 | Rooms / group chats; bot-to-bot (bridged to Hermes `message_agent` / hosted rooms) | P1 |
| AG-4 | Routines = Hermes cron jobs; tasks = Hermes kanban; edited in the App | P0 |
| AG-5 | Delegation / subagent settings, goals, loops, insights, usage | P1 |
| AG-6 | Voice (provider-agnostic; xAI first) | P1 |
| AG-7 | Connected apps (Composio first, as an extension) | P1 |
| AG-8 | Many bots per gateway via Hermes profiles; no fixed bot limit | P0 |

### 5.4 Computers (screen-agnostic)
| ID | Requirement | P |
|---|---|---|
| CO-1 | `ComputerProvider` interface; any bot or agent can be assigned any computer | P0 |
| CO-2 | Providers v1: Hermes Bot Screen (any Linux / sandbox), your own desktop (cua-driver), Docker desktop, any VNC machine, Orgo | P0 |
| CO-3 | Live viewer, watch / take over / hand back (leases), in App and PWA | P0 |
| CO-6 | Computer safety baseline (headless default, agent indicator + kill switch, clipboard guard, per-task isolation, checkpoints) | P0 |
| CO-7 | `computer-boat` (boat.dev API: cloud + self-hosted PandaOS) | P1 |
| CO-4 | Same computer usable by Hermes bots, DSH sessions and the super agent | P0 |
| CO-5 | Cloud sandboxes (E2B, Daytona, appsandbox, Simular box, Modal), browser-only computers (Steel, Browserless, BrowserHarness) | P2 |

### 5.5 Skills (learned skill system)
| ID | Requirement | P |
|---|---|---|
| SK-1 | Skill Registry: agentskills.io format, versions, provenance, usage, scopes, autonomy ceiling | P0 |
| SK-2 | Hermes learning loop surfaced: `/learn`, agent-created skills, background review, curator, learning graph | P0 |
| SK-3 | Projection of registry skills to Hermes, DSH and T3 providers (`.agents/skills`) | P0 |
| SK-4 | Eval gate + approval before promoting agent-created or agent-modified skills; one-click rollback | P0 |
| SK-5 | Hub: install from Hermes official, ClawHub, skills.sh, GitHub, NeoMetaHarness-Skills, with a security scan | P1 |

### 5.6 Memory
| ID | Requirement | P |
|---|---|---|
| ME-1 | L1 local memory (in-process oRPC + MCP) as the default memory provider for all engines | P0 |
| ME-2 | L2 Honcho self-hosted; L1 ↔ L2 sync | P0 |
| ME-3 | SOUL.md / USER.md / MEMORY.md / daily notes as exported views; edited in the App | P0 |
| ME-4 | Dreaming with provenance + review report | P1 |
| ME-5 | Memory browser: search, edit, retract, provenance trail | P0 |
| ME-6 | Standing intents; channel trust levels | P1 |

### 5.7 Coding
| ID | Requirement | P |
|---|---|---|
| CD-1 | Coding section on T3's server through Neo's thin RPC client (pinned protocol v2): projects, threads, composer, approvals, diff, checkpoints, worktrees, terminal, commit / push / PR | P0 |
| CD-2 | Providers: DSH (default), Claude Code, Codex, Cursor, OpenCode, any ACP agent | P0 |
| CD-3 | DSH with Neo memory, soul, skills and reporting plugins | P0 |
| CD-4 | Super-agent-delegated threads appear in the same UI | P0 |
| CD-5 | Remote environments (coding on another machine) | P1 |

### 5.8 Channels and models
| ID | Requirement | P |
|---|---|---|
| CM-1 | Any Hermes platform as a channel; user picks in onboarding (Telegram suggested; WhatsApp, Slack, Discord, Signal, Teams, iMessage, Email… available) | P0 |
| CM-3 | Panda Router as the default per-turn model picker; route → verify → escalate → record outcome | P0 |
| CM-2 | Model Hub: vault credentials (API keys + subscription sign-ins), route roles, fallbacks, budgets, projected to all engines | P0 |

### 5.9 Platform, extensions, teams
| ID | Requirement | P |
|---|---|---|
| PL-1 | Extension system per [05](05-extension-system.md): manifest, lifecycle, toggle, permissions, health | P0 |
| PL-2 | TS and Python extension SDKs + `neo ext new` templates (planned; sample extensions and templates provided today) | P1 |
| PL-3 | Workspaces, members, roles; SQLite default, Postgres option | P0 |
| PL-4 | Topologies: all-in-one, hybrid, server; `neo install / doctor / backup` (unified CLI planned; installer checks and `pnpm neo:backup / restore` today) | P0 |
| PL-5 | Upstream registry + local `pnpm upstream:check` / `neo upstream bump` + contract tests (no GitHub Actions) | P0 |
| PL-6 | Opt-in telemetry (OpenTelemetry); health page | P1 |

### Non-goals for v1
Native mobile apps, a hosted SaaS, billing, a public extension marketplace with payments, training the small router model, and running OpenClaw as an engine.

## 6. Success metrics
- **One product:** 100% of v1 screens use `@neometaharness/ui`; no embedded upstream UI.
- **Toggle safety:** turning off any non-kernel extension leaves the rest healthy (automated test over all official extensions).
- **Attention:** ≥ 70% of Tickets finish with only the request plus at most one approval.
- **Learning:** ≥ 1 promoted skill per 20 completed Tickets by month 2; promoted-skill rollback rate < 10%.
- **Agnostic:** every capability interface has ≥ 2 working providers at v1 (computers ≥ 4, models ≥ 5, channels ≥ 4, memory 2).
- **Freshness:** engines no more than 14 days behind stable; contract break triaged within 48 h.
- **Time to first value:** install → first bot answering on a chosen channel in < 15 min.

## 7. Risks
| Risk | Mitigation |
|---|---|
| Rebuilding T3-quality coding UI in Astryx is large | Thin Neo RPC client over T3's pinned Effect schemas (~200–400 LOC, spike a); a live contract test with a fake ACP agent; P0 spike; ship the coding MVP first, then reach parity in steps |
| DSH developer-preview breaking changes | Pin, weekly bumps, contract tests, thin plugin surface |
| Hermes is huge and moves fast; App exposes a lot of it | Engine extension maps Hermes APIs to the Neo API; contract tests per used endpoint; expose features in waves |
| Astryx is beta (React 19); bot-hq / DSH web are React 18 | Only Neo App code uses Astryx; adopted bot-hq UI is rewritten anyway |
| Extension API churn | Semver, deprecation window, official extensions as the reference tests |
| Computer seams in Hermes / DSH may not accept external screens | P0 verification; fall back to Neo MCP computer tools that engines call |
| Memory poisoning, extension supply chain | Trust levels, candidate memory, signatures, permission review, process isolation |
| System webviews differ (WebKitGTK on Linux) | Playwright Chromium + WebKit matrix, RFB/noVNC viewer by default, `@neometaharness/shell` keeps an Electron fallback possible |
| No CI (GitHub guardrails) | Local `pnpm check` pipeline; pre-push hooks; reproducible scratch profiles |

## 8. Open questions (non-blocking)
- Product name and brand ("Neo" in UI?) → NeoMetaHarness-Brand.
- License: MIT (matches all upstreams; default).
- Default model routes shipped out of the box (suggest: DeepSeek for router and coding, user's choice for bots).
