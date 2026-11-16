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

## Done means verified
A tool call succeeding is not proof that the work is done. Verify the resulting state, then update `machine/readiness.json` (and Progress-Memory) only from evidence.
