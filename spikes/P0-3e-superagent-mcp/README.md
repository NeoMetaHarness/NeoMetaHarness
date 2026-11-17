# P0-3e dsh-superagent custom Source + DSH worker MCP

Verdict: **WORKS WITH WORKAROUND**

Question: Can Neo register an independent Superagent Source kind and attach a new MCP server only to DSH worker presets, without modifying upstream engines or requiring a real LLM?

Pinned refs: `deepseek-ai/dsh-superagent-prototype@8c32a9dc5d72`; `deepseek-ai/deepseek-harness@0.2.2-rc.1` (published DSH packages at `0.2.2-rc.1`, Cordis `4.1.0`, MCP SDK `2.2.0`). Local upstream source resides at `C:\Users\Neo\Desktop\nmh-upstream-cache\<name>@<ref>` and was treated read-only.

Seam:

- Superagent `src/sources/kind.ts`, `src/sources/registry.ts`, `src/app/source-context.ts`, `src/infra/health.ts`, `src/policy.ts`, and `docs/008-cookbook.md`: `SourceKind` with Zod config, `SourceRegistry.register()` with effect disposer, `sourceContextOf()` exposing receive/state/atomic/report, registry scope and `assessmentOutcome()` policy decision.
- DSH `packages/mcp/mcp-client/src/index.ts`, `src/transport.ts`, `src/tools.ts`: `mcp-client` Cordis plugin (named exports) with stdio, namespace `mcp__<server>__<tool>`, scoped tool registration and cleanup.
- DSH `packages/preset/agent-preset-registry/src/index.ts`, `src/mount.ts`: `agentPresets.register({id,plugins:[...]})`, agent-specific `agentPresets.mount(owner, id)`; the plugin row is loaded from the pinned published `@deepseek-ai/dsh-mcp-client` file URL. `packages/experimental/cua/tests/agent-scopes.spec.ts` and `packages/mcp/mcp-client/tests/mcp-client.e2e.ts` are upstream reference fixtures.

Reproduce from PowerShell:

```powershell
cd C:\Users\Neo\Desktop\nmh-wt\codex\spikes\P0-3e-superagent-mcp
pnpm.cmd install --ignore-scripts --frozen-lockfile
pnpm.cmd test
```

This runs real pinned upstream Superagent registry/context/policy source **bundled locally by esbuild** in `dist/superagent.mjs` (no upstream modifications), an in-memory fake Source delivery boundary, and real published DSH Cordis preset, tools, and MCP client packages. The MCP server runs as an isolated `node fixture-server.mjs` stdio child. `DSH_HOME` is set to this spike's ignored `.cache/dsh-home` before initializing DSH libraries. No global install, subscription, user login, live model, or user DSH home is involved.

Evidence (trimmed actual `pnpm.cmd test`, Windows / Node `v22.23.2`, 2026-11-17):

```text
SUPERAGENT_BUILD pinned source 8c32a9dc5d72 PASS
SOURCE_REGISTRY PASS registration, duplicate kind/health, validation, scope
SOURCE_INGEST PASS failure kept cursor=1; recovered ids=m1,m2,m3; rewind deduped=3
SOURCE_STATE PASS disabled/unconfigured skipped; health ready/error/paused; disposed registration & health
SOURCE_POLICY PASS upstream assessment with no matched rules ignored
PRESET_ROSTER [{"id":"neo-worker"},{"id":"neo-worker-alt"},{"id":"standard"}]
MCP_WORKER PASS worker/alternate have tools, standard/root absent; serverName reused across presets
MCP_STDIO PASS add(20,22)=42; fail returned isError=true
MCP_DISPOSE PASS agents and preset definitions removed; root has no MCP tool
```

The Source fixture deliberately fails receipt of `m2`. The persisted cursor remains at `1`; successful retries deliver `m2` and `m3`. Explicit rewind to `0` does not duplicate the three IDs **because the fake `deps.receive` implements deduplication**. The proof exercises the real source API, registry, schema, health and policy but **does not** exercise the complete Superagent Engine, durable message store, evaluator, ticket creation, or real worker delegation. Source ingestion and cursor advancement are fixture logic modeled on the upstream cookbook.

The MCP side **does** start a real stdio MCP server, discovers tools through DSH `mcp-client` and executes `add` and `fail`. Two concurrently mounted worker presets reuse the `neo` serverName independently, while the standard preset and root see no such tools. Releasing agent handles and unloading the preset declarations succeeds. This proves scoped preset tool exposure and live protocol execution; no LLM-driven tool selection was tested.

Risks:

- Superagent SourceRegistry, source context, and policy are imported from **application source**, not a published stable API. Bundling the pinned SHA via esbuild is a practical spike workaround; introduce a small pinned Neo adapter and contract tests before production. Semantics of `receive`, state, health and policy can drift.
- MCP tool visibility depends on DSH scope binding and loader entry resolution. `import.meta.resolve('@deepseek-ai/dsh-mcp-client')` produces a concrete file URL suitable for the isolated loader; bare package resolution may fail under a different profile root.
- The MCP fixture validates a normal successful call and a protocol-reported tool failure, but not reconnect, worker restart, permission enforcement, malicious tools, or transport isolation. Do not generalize from this test to those properties.
- Local Node `v22.23.2` passed; the DSH upstream declares Node `>=24.9.0`. Repeat on supported Node for an integration release.

Architecture impact: **Keep** `docs/02-architecture.md` section “Super agent” (`neo/*` Source kinds and worker MCP delegation) and `docs/05-extension-system.md` Sources/DSH projection plan. For the Source bundle, define a pinned `NeoSourceAdapter` that owns `register`, `receive`, config, state, and disposal; enforce policy in the upstream evaluator, not a Source plugin. For workers, make the Neo extension patch the DSH **agent preset plugin rows** with one scoped MCP client per worker composition; resolve plugin paths to file URLs from the extension installation root. Preserve isolation from non-worker presets.

Contract test idea: Against each upstream bump, require schema + SourceKind registration and effect disposal, failure-before-ack cursor recovery, disabled/no-config health, SourcePolicy no-rules ignored, two worker preset activations sharing a namespace, a standard agent without MCP tools, actual stdio `add(20,22)=42`, error result, and preset unload with no root leak. Add a separate full Superagent Engine-to-DSH ticket/worker test once that host wiring exists.
