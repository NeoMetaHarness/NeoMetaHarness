# Coding workflow (P5-5)

Engines are unmodified. T3 references below are at `t3code` v0.1.9,
SHA `24e77473ecf41bc1f7142529c7911c1c1aae1d76` from `upstream.lock.json`.

* Local ACP provider: `packages/contracts/src/rpc.ts:853`,
  `server.updateSettings` with `providerInstanceMutation` (driver `acpRegistry`,
  local `commandPath` / `commandArgs`). The test already uses this seam in
  `extensions/engine-t3/test/wire.entry.ts:54`.
* Change provider without changing thread identity:
  `packages/contracts/src/orchestrationV2.ts:3174`, `thread.model-selection.set`.
* Worktree creation: `packages/contracts/src/rpc.ts:1557` and
  `packages/contracts/src/git.ts:154`, `vcs.createWorktree` (server chooses path).
  Bind it to the empty thread using `thread.metadata.update`,
  `packages/contracts/src/orchestrationV2.ts:3086` (`expectedEmpty` guard).
* Read-only terminal subscription: `packages/contracts/src/rpc.ts:1615`,
  `terminal.observe`; opening uses `terminal.open` at line 1602.

The `neo-coding` ACP command connects over a private, token-protected local IPC
socket to the extension, which uses the existing `dshAgentRuntime` service.
The runtime supplies isolated DSH homes and vault/model/skills/memory projections.
The token file contains only an ephemeral IPC capability, never model credentials.
Disabling coding-workflow closes its sockets and DSH sessions. Disabling DSH makes
new requests fail; existing DSH processes are stopped by engine-dsh itself.

PR preparation is local: stage explicit selected paths in the thread worktree,
commit them, and write a Markdown description to extension storage. It never
pushes or invokes GitHub. Git runs with argument arrays, without a shell.
