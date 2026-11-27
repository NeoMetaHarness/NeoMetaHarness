# Changelog

All notable changes to Neo Meta Harness. Versions follow [Semantic Versioning](https://semver.org/).
Every release is a full GitHub release (never a pre-release or draft); see [docs/release.md](docs/release.md).
The release notes in each update manifest (`latest.json`) are the section for that version below.

## [1.0.2] - 2026-11-28

Subscription sign-in, a premium light and dark design, and interactive replies (P7-17, P7-18, P7-19).

### Models and sign-in
- Onboarding and the Model Hub offer subscription sign-in for each engine (P7-17). Hermes signs in to ChatGPT/Codex with a device code for the selected bot profile; local T3 uses its own sign-in. Each engine keeps its own credentials; Neo stores only the provider record and its status.
- Claude: Neo detects an existing Claude Code sign-in through T3 and explains how to sign in or out there.
- Local AI presets for Ollama (`http://127.0.0.1:11434/v1`) and LM Studio (`http://127.0.0.1:1234/v1`), next to the OpenAI-compatible API option.
- Sign-in can be cancelled, expires cleanly, and can be signed out from the Model Hub. Signing out revokes the stored approval first. Only owners and admins can manage sign-ins and providers; members and viewers see the saved status.

### Design
- One Neo theme on Astryx with light and dark modes: System, Light or Dark in **Settings > Appearance**, applied before the first paint, and followed by the desktop title bar (P7-18).
- Every page polished to it: shell and navigation, setup screens, Settings, Extensions and engine install, Registry, Agents, Channels, Computers, Memory, Metrics, Skills, onboarding, Coding, Inbox, Routines, Tasks and the Model Hub. Contrast meets WCAG AA in both modes.

### Interactive replies
- Hermes and T3 conversations can show interactive replies (forms, choices, buttons) rendered with Astryx, and send your answer back to the conversation (P7-19, A2UI). Turning the extension off falls back to plain text.

## [1.0.1] - 2026-11-24

Engines install inside the app (P7-16). In 1.0.0 only DeepSeek Harness worked in an installed app: Hermes, the super agent and T3 needed a development checkout.

### Engines
- Hermes, the super agent and T3 each have an **Install** button in onboarding and on the Extensions page. Neo downloads the engine at the version pinned in `upstream.lock.json`, checks it against the pinned checksum and commit, and installs it into its own data folder. Engines are never modified.
- Hermes gets its own Python environment from the bundled, checksum-pinned `uv`. Channels and bot creation work once it is installed.
- The super agent is built from its pinned source and reused while that source is unchanged. It needs Hermes and says so until Hermes is installed.
- T3 installs the official prebuilt T3 release and runs on this computer only (loopback), with its own isolated home folder. Its session is renewed and revoked in the background without interrupting open threads or the terminal. You can also connect to an existing T3 server in Settings (https, or loopback).
- While an engine is still starting, its pages wait for it or say plainly that it is not connected, instead of showing an error.

### Known limitations
- T3's coding agents can still reach credential stores the operating system provides to every program (for example Git Credential Manager and the ssh-agent). Neo does not pass them any of its own secrets.

## [1.0.0] - 2026-11-23

First public release. This section lists the tasks marked `done` in `machine/readiness.json` (P0–P7).

### Desktop and web app
- Neo App on the Astryx design system, served as a web app and PWA and as a Tauri 2 desktop app with the Gateway as a sidecar, tray, global launcher, `neo://` deep links and clean exit (P1-2, P1-5, P1-8).
- Onboarding wizard (owner, model provider, first bot, first run), measured under 15 minutes (P1-8, P7-8).
- Schema-driven Settings for every extension, with per-workspace values and secrets (P1-9, P1-13).
- Installers for Windows (NSIS, MSI), macOS (DMG) and Linux (AppImage, deb), with install docs (P7-6).
- In-product PRD success metrics (P7-12).
- Signed desktop auto-updates from full GitHub releases, verified with the checked-in public key; stable versions only (P1-11).
- The desktop Gateway sidecar never outlives the app: it shuts down when the app exits, crashes or fails to start (P1-15).
- Installers carry the Gateway runtime (production dependencies only, one shared package folder) as a single archive that the app unpacks into its data folder on first launch and after each update (P7-14).
- While it unpacks that archive the app shows a "Setting up Neo" screen instead of nothing (P7-15).

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
- GitHub org repositories with a shared router, templates and a generated extension capability inventory checked by `pnpm check` (P0-1).
