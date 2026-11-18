# T3 coding provider integration

T3 v0.1.9 exposes provider instances and model slugs in `server.getConfig` (`packages/contracts/src/rpc.ts:647-651`, `server.ts:207-271`). The extension forwards a sanitized provider catalog for the Coding composer. `neo-coding` is selected first if T3 reports it as enabled and installed, followed by the project's default instance.

A DSH-backed `neo-coding` instance can be provisioned through T3's provider-instance settings mutation (`apps/server/src/ws.ts:2714-2725`, `extensions/engine-t3/test/wire.entry.ts:54-57`). That requires a compatible T3 provider driver and an explicit integration configuration. This extension does not mutate the T3 installation or synthesize a provider that T3 cannot run.

Thread history and checkpoints are read from `orchestration.subscribeThread` snapshots (`packages/contracts/src/orchestrationV2.ts:2040-2062,3958-3982`). The conversation-only `checkpoint.rollback` command is defined in that contract at `:3334-3340`. File restoration requires isolated-worktree handling (`apps/server/src/orchestration-v2/CheckpointRestoreSafety.ts:10-11`), so the Coding page leaves workspace files unchanged.
