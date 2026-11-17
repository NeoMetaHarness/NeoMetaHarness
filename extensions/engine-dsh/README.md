# DeepSeek Harness engine (P2-2)

Neo Meta Harness loads the published `@deepseek-ai/dsh@0.2.2-rc.1` SDK CLI with `--profile sdk --patch` and registers a Neo Cordis plugin for `computerUse`, `browserUse` and `llm`. Computer/browser providers are placeholders. The `neo-scripted` model adapter produces a deterministic response without credentials or network requests.

The gateway provides `agentRuntime` through `extensions/engine-dsh` and HTTP/WS oRPC paths under `/x/engine-dsh/`. Create accepts an absolute workspace `cwd` and `workspaceId`. Prompt, events, wait, cancel and shutdown operate on a returned session ID. The gateway coalesces text events in 33 ms windows by message ID. Every session owns its own SDK process, Cordis plugin, temporary `DSH_HOME` and `DSH_AGENTS_HOME`, under the Gateway-owned extension data directory adjacent to the Gateway database. This process isolation supports cancellation because the pinned SDK has no cancel RPC.

Credentials are read only from the engine-specific Vault scope for the requested workspace and projected through `DshProjector`. The process spawn environment includes only that projector's allowlist and explicitly assigned DSH runtime values. Disable disposes the extension service, stops the DSH process trees and withdraws the routes. The upstream engine is consumed without modifications.

Run `pnpm --dir extensions/engine-dsh test` for the isolated, temporary-directory gateway end-to-end test. Set `NMH_UPSTREAM_CACHE` to the local upstream cache, or place `nmh-upstream-cache` in an ancestor directory. The test verifies the installed version against `upstream.lock.json`, and runs with the scripted adapter and no credentials.

Upstream declares **Node >=24.9.0**. Integration tests currently run with **Node 22.23.2**. The published SDK seam was exercised successfully under this version, and Node 24+ qualification remains advisable before production release.
