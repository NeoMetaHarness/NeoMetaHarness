# AGENTS.md: NeoMetaHarness (product)

Read first: `docs/02-architecture.md`, `docs/05-extension-system.md`, `machine/readiness.json`.

## Invariants
- **Engines are consumed unmodified.** DeepSeek Harness, dsh-superagent, Hermes, T3 Code, Honcho and Panda Router are reached only through the seams listed in `upstream/registry.yaml`. Engines come from their source repos at the pinned ref. Never patch an engine and never vendor-modify one. If a seam is missing, open an upstream issue or PR.
- **Everything is an extension.** New features go in `extensions/<name>` with a `neo.extension.json`. Disabling any extension must leave the rest healthy.
- **One design.** UI uses `@neometaharness/ui` (Astryx) only. No other component libraries, and no embedded upstream UIs.
- **Thin shell.** The Tauri Rust shell handles OS concerns only. Business logic lives in the Gateway, so web and PWA behave the same.
- **Agnostic.** Every external dependency sits behind an interface. Don't hard-code a model, channel, computer, memory store or database.
- **Hot paths stay out of React state.** Streamed text, terminal output and logs use dedicated renderers. Batch (coalesce) deltas in the Gateway.
- bot-hq-derived code (`packages/agents`) is first-party. Keep the MIT attribution in `THIRD_PARTY_NOTICES.md`.

## GitHub
Follow `docs/policies/GITHUB-SAFETY-GUARDRAILS.md`: no Actions, local checks, at most 20 writes per task, stop on 403/429.

## Checks
`pnpm check` runs before every push: guardrails, machine JSON, docs links, and the upstream registry schema.
`pnpm upstream:check` reports upstream drift against `upstream.lock.json`. It is read-only.

## Plans and status
- `machine/readiness.json` is the **only** status source. Each task (`P0-1`, `P1-8`, ...) has `status`: `done`, `in_progress`, `review`, `not_started` or `dropped`.
- `docs/04-roadmap.md` is the plan (what each task means). It carries no status; don't infer status from it.
- `docs/03-PRD.md`, `docs/02-architecture.md` and `docs/adr/` are design intent. `spikes/` are finished experiments, not current code.
- `archive/` holds retired docs. Don't read it.

## Source of truth
- **The code is the source of truth.** If a doc, ADR, spike README, roadmap line or code comment disagrees with the code, trust the code and tell me about the mismatch. Don't change the code to match the doc.
- **Exception:** for a task with status `in_progress` or `review`, the roadmap describes intended work. Follow the plan there, not the half-built code.
- A roadmap item missing from the code is only "to do" if its task is `in_progress` or `not_started`. If it's `dropped`, leave it alone.

## Stay on task
- Only change what I asked for. If you notice other bugs, TODOs, drift or missing features, list them at the end. Don't fix or build them.
- Don't start the next roadmap task unless I ask.

## New requests vs the plan
- Before building something that isn't a roadmap task, check it against `docs/04-roadmap.md`, `docs/03-PRD.md` and the ADRs. If it overlaps or conflicts, tell me and ask before building.
- When I confirm a change of plan, update the roadmap or ADR in the same task.

## Hygiene
- One task per session. Start a fresh session for a new task, and between planning and building.
- Run the `sweep` skill now and then to find docs that no longer match the code.

## Done means verified
A tool call succeeding is not proof that the work is done. Verify the resulting state, then update `machine/readiness.json` (and Progress-Memory) only from evidence.
