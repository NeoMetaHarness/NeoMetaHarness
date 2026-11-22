# Changelog

All notable changes to Neo Meta Harness. Versions follow [Semantic Versioning](https://semver.org/).
Every release is a full GitHub release (never a pre-release or draft); see [docs/release.md](docs/release.md).
The release notes in each update manifest (`latest.json`) are the section for that version below.

## [1.0.0] - Unreleased

First public release. This section lists the tasks marked `done` in `machine/readiness.json` (P0–P7).
Set the date on the heading when the release is cut.

### Desktop and web app
- Neo App on the Astryx design system, served as a web app and PWA and as a Tauri 2 desktop app with the Gateway as a sidecar, tray, global launcher, `neo://` deep links and clean exit (P1-2, P1-5, P1-8).
- Onboarding wizard (owner, model provider, first bot, first run), measured under 15 minutes (P1-8, P7-8).
- Schema-driven Settings for every extension, with per-workspace values and secrets (P1-9, P1-13).
- Installers for Windows (NSIS, MSI), macOS (DMG) and Linux (AppImage, deb), with install docs (P7-6).
- In-product PRD success metrics (P7-12).
- Signed desktop auto-updates from full GitHub releases, verified with the checked-in public key; stable versions only (P1-11).

### Kernel, extensions and Gateway
- Cordis kernel facade, oRPC contracts, Kysely/SQLite state, Gateway, and sample TypeScript and Python extensions (P1-1).
- Blue/green extension upgrades without dropping in-flight requests (P1-10).
- Per-workspace extension settings and secrets (P1-13).
- Extension toggle-safety suite: disabling any extension leaves the rest healthy (P7-1).
- Upstream registry, lock file and local drift check; `neo upstream` as a super-agent routine that raises Inbox Suggestions (P0-4, P6-3, P6-8).
- Local check pipeline with performance budgets (P0-2, P1-12).

### Security and accounts
- Encrypted vault with engine projectors (P1-3).
- Authentication in the Gateway, route policy table with contract-coverage tests (P1-6, P1-7).
- Deployment owner role, separate from each workspace's owner (P1-14).
- Security reviews, threat model and fixes, including headless Chrome over a pipe with no debugging port (P4-7, P7-2, P7-4, P7-5, P7-9).

### Engines and agents
- Engines consumed unmodified through their seams: Hermes (`engine-hermes`), DeepSeek Harness (`engine-dsh`), T3 Code (`engine-t3`) and the super agent (`engine-superagent`) (P1-4, P2-1, P2-2, P5-1).
- Agents service and Agents page: bots, streaming chat, approvals and stop, on Hermes (P2-0, P2-3, P2-4).
- Routines (Hermes cron) and Tasks (Hermes kanban) (P2-7).
- Channels: Telegram and WhatsApp through Hermes platforms (P2-5, P6-5).
- Provider-agnostic voice with an xAI provider (P2-10).
- Optional X search extension (P2-11).
- Connected apps through Composio behind the `neo.apps` interface; destructive actions need the account owner and a workspace admin (P2-12).

### Models
- Model Hub: providers with keys in the vault, route roles, projections into Hermes and DSH (P2-6).
- Panda model router behind the model-router interface, with task-aware escalation for super-agent evals (P2-8, P2-9).

### Coding
- Coding page over T3 Code: threads, composer, streaming, approvals, history, per-turn diffs, checkpoints, provider choice, DSH as a T3 provider, worktrees, terminal and PR preparation (P5-2, P5-4, P5-5).

### Computers
- Screen-agnostic computers: registry, safety events, kill switch and leases, projected into every engine over MCP (P3-1, P3-7).
- Providers: headless Chrome, VNC, Docker, opt-in local desktop, Hermes bot screen, Orgo and boat.dev/PandaOS; a bot can swap computers without a restart (P3-2, P3-3, P3-4, P3-6, P3-8, P3-9, P3-10, P3-11).

### Memory and skills
- L1 local memory with the single `neo` Hermes memory provider and a Memory page; Honcho L2 (self-hosted) with L1↔L2 sync, dreaming reports and admin-managed standing intents (P4-2, P4-5, P4-9, P4-10).
- DSH plugins for memory, soul, skills and reports (P4-4, P5-6).
- Skills page, git-backed skills registry projected into Hermes, DSH and the super agent, with an eval gate, autonomy ceilings and a scanned Hub install (P4-1, P4-3, P4-6, P4-8).
- Episodes and playbooks feed the skills fabric (P6-7).

### Inbox and super agent
- Inbox page and production super-agent worker: Source → Eval → Ticket → worker → report (P5-1, P5-3).
- Sources: app, cron, channel, upstream and GitHub (`@neo` comments, failing checks), with policy from member identity (P6-1, P6-3, P6-4).
- Decision log with Panda-compatible traces and post-mortems that propose skills (P6-2).
- Per-workspace accept modes (`observe`, `act-with-approval`, `act`) and the Suggestions lane (P6-6, P6-9).
- Inbox and memory isolation per workspace (P6-10).

### Operations and docs
- Self-hosted Docker Compose stack and deploy docs (P3-5).
- Encrypted backup and restore drill (P7-3).
- Static docs site and user docs; docs reconciled with the code (P7-7, P7-10, P7-13).

### Not in this section yet
Tasks still `in_progress` in `machine/readiness.json` when this was written, and not listed above:
the org repositories (P0-1). Move it up when it is done, before the release is cut.
