# ADR 0004 · Gateway kernel: Cordis, the same build DSH ships, behind `@neometaharness/kernel`

Status: **Accepted** · 2026-11-18 · Evidence: spikes [d](../../spikes/P0-3d-dsh-seams/README.md) and [e](../../spikes/P0-3e-superagent-mcp/README.md) (Codex; reproduced by the PM)

## Context
"Everything is an extension" ([docs/05](../05-extension-system.md)): turning any extension off must cleanly undo everything it registered (routes, tools, providers, projections) and leave the rest healthy. DSH and dsh-superagent already run on **Cordis**, and Neo's DSH plugins (computer/browser providers, LLM adapters, memory, skills) are Cordis plugins inside DSH anyway.

Facts checked on 2026-11-18:
- `@deepseek-ai/cordis` 4.1.0 is DSH's packaged build (`vendor/cordis`) of Shigma's MIT **Cordis** (`cordiverse/cordis`, npm `cordis` 4.0.0-rc.13). MIT, like Neo.
- Spike d: with real Cordis 4.1.0, a plugin's registrations (`computerUse`, `browserUse`, `llm.registerAdapter`) were released on unload, duplicates were rejected, and re-registration worked.
- Spike e: preset-scoped MCP tools were removed with their preset, with no leak to the root scope.

## Options
1. **Cordis (DSH's build)**: reversible effects, services with `inject`, scoped contexts, a plugin loader. Proven twice in our spikes, and it is the same kernel our DSH plugins already target.
2. Upstream `cordis` from npm: the same design, but a release candidate and not the build DSH tests against.
3. Our own DI + lifecycle (Awilix or hand-rolled): full control, but we would rebuild reversible effects, scoping and the loader, and DSH plugins would still need Cordis.

## Decision
The Gateway kernel uses **Cordis, pinned to the exact version DSH pins** (today `@deepseek-ai/cordis@4.1.0`), so Neo's in-process extensions and Neo's DSH plugins share one plugin model. Extensions never import Cordis directly. They use the **`@neometaharness/kernel`** facade: `defineExtension`, `ctx.provide/inject`, `ctx.effect`, routes, contributions and health. The facade is the swap point for upstream `cordis` or our own kernel if DSH's build ever diverges.

## Consequences
- `upstream/registry.yaml` tracks Cordis as part of the DSH pin. A DSH bump that changes Cordis gets the kernel contract test: load → register → duplicate rejected → unload releases everything → re-register.
- Process extensions (third-party by default) don't run in Cordis. The kernel mirrors their lifecycle over JSON-RPC/MCP with the same enable/disable semantics.
- Plugin entry points are resolved to file URLs from the extension's install root (spike d finding), never bare package names.
- One Node runtime: Node 24 LTS for the Gateway and DSH (DSH needs ≥ 24.9).
