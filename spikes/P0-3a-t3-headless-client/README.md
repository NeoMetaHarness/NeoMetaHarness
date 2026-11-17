# P0-3a T3 headless client

**Verdict: WORKS WITH WORKAROUND**

**Question:** Can a client outside T3 React create threads, send turns, stream ordered events and decline approvals against a real T3 server using the upstream contracts and client runtime?

**Pinned ref:** T3 Code `v0.1.9` at `24e77473ecf41bc1f7142529c7911c1c1aae1d76`, read-only source in `C:\Users\Neo\Desktop\nmh-upstream-cache\t3code@v0.1.9`. Both bundle entry points fail closed on SHA mismatch.

**Seam (pinned files and APIs):**

- `packages/contracts/src/orchestrationV2.ts`: protocol v2, `orchestration.dispatchCommand` (`thread.create`, `message.dispatch`, `runtime-request.respond`, `thread.settle`), `orchestration.subscribeThread` and sequenced events.
- `packages/client-runtime/src/rpc/protocol.ts`: `makeWsRpcProtocolClient` on Effect RPC socket/JSON layers. `run-live.mjs` imports only the required pinned source into a local esbuild bundle.
- `apps/server/src/ws.ts`, `apps/server/src/auth/http.ts`: authenticated WebSocket upgrade. A scoped bearer token is used for `POST /api/auth/websocket-ticket`; the resulting one-use ticket is passed as `wsTicket` on `/ws?orchestrationProtocol=2`. This is the server-supported browser-compatible upgrade path.
- `apps/server/scripts/acp-mock-agent.ts`: ACP v2 `state_update` with `state: "idle"` and `stopReason: "end_turn"` closes a prompt. The minimal local `fake-acp.mjs` reproduces that handshake; its tool call only names a dummy command, never executes anything.
- `packages/contracts/package.json` and `packages/client-runtime/package.json`: both marked `private: true`. No supported public standalone SDK is implied by the imports.

**Evidence:** Windows PowerShell; Node v22.23.2 and local T3 CLI v0.1.9. Run `npm.cmd ci` inside this spike, then `npm.cmd run probe`, `npm.cmd run fake:smoke`, `npm.cmd run live:compile`. For the live test, start **only** a throwaway T3 instance on port 43871 with isolated state:

```powershell
$stateDir = Join-Path (Get-Location).Path '.cache/t3state'
t3.cmd serve --mode desktop --host 127.0.0.1 --port 43871 --base-dir $stateDir --no-browser
# In a separate shell inside this spike; keep the session secret in process memory:
$stateDir = Join-Path (Get-Location).Path '.cache/t3state'
$scopedSession = (& t3.cmd auth session issue --base-dir $stateDir --scope orchestration:read --scope orchestration:operate --scope providers:manage --ttl 15m --label nmh-isolated-test --token-only | Out-String).Trim()
try {
  $env:NMH_T3_SCOPED_SESSION = $scopedSession
  npm.cmd run live:e2e
} finally {
  Remove-Item Env:NMH_T3_SCOPED_SESSION -ErrorAction SilentlyContinue
  $scopedSession = $null
}
```

All three scopes are necessary for this **combined** scenario: orchestration read/operate plus local fake provider registration (providers manage). Credentials are never printed, written to repo files or included here. The test uses a throwaway ACP provider, no paid model and no personal provider sign-in; the state, workspace, and bundled runtime live only in ignored `.cache/`.

```text
npm.cmd run probe
source_contract=PASS protocol=2 dispatchCommand subscribeThread
client_runtime=PASS compatibility + Effect RPC client factory import
command_schemas=PASS thread.create message.dispatch runtime-request.respond subscribeThread synchronized reject-invalid

npm.cmd run fake:smoke
fake_acp=PASS initialize session/new session/prompt chunk_count=3 permission=reject_once final=end_turn

npm.cmd run live:e2e
live_client_bundle=PASS pinned_sha=24e7747
provider=local_fake_acp registered
project.create=ACK isolated_workspace=true
thread.create=ACK sequence=166
subscribeThread=snapshot
message.dispatch=ACK sequence=174
run.updated sequence=178 status=running
message.updated sequence=186 text_chars=33
runtime-request.updated sequence=189 status=pending
runtime-request.respond=ACK sequence=193 decision=decline
runtime-request.updated sequence=191 status=resolved
message.updated sequence=197 text_chars=19
run.updated sequence=202 status=waiting
run.updated sequence=208 status=completed
thread.settle=ACK sequence=211
thread.settled sequence=210
stream_text="neo fake streamed text, part two. Approval declined." ordered_sequences=true
live_e2e=PASS events=44 streamed_messages=2 run=completed pending=true declined=true resolved=true settled=true
```

The event subscription checks **strictly increasing sequence** and the exact ordered concatenation of two fake text updates. A `runtime-request.updated` pending approval is declined through RPC and later streamed as resolved. The fake ACP emits `state_update: idle` to complete its run; `thread.settle` explicitly settles the completed thread, and the client waits to receive the `thread.settled` event. The RPC ACK sequence can be ahead of a queued event: this does not violate event-stream ordering.

**Dependency policy recommendation:** Do **not** rely on installing the private packages from npm. Vendoring pinned source is feasible: `git ls-tree -r -l HEAD -- packages/contracts` finds 112 files / 1,184,365 bytes; `packages/client-runtime` finds 406 files / 3,822,321 bytes, totaling **518 files / 5,006,686 bytes (~5 MB)** before workspace transitive dependencies. Estimated 3-5 engineering days to integrate/build, then sync work per upstream update. A **thin Neo RPC client against the pinned Effect schemas** (only the needed methods, ticket flow, event projection, reconnection and version checks) should be roughly **200-400 LOC / 1-3 engineering days** initially, plus contract/live tests, and is the recommended production direction. These sizes and times are estimates, not measured implementation work.

**Risks:** Private internal APIs can drift at every upstream bump; a static bundle carries a version-sensitive Effect dependency graph. The test verifies one authenticated socket and short run, not reconnection under outages, multi-client concurrency, pagination, or server restart recovery. `thread.settle` is a separate user-facing action from run completion. Temporary state directories and orphaned test processes should be cleaned after runs.

**Architecture impact:** Update `docs/02-architecture.md` (T3 integration row) to say a non-T3 app can drive a local, authenticated T3 server through version-pinned Effect RPC with explicit approval and settlement handling. Prefer a narrow Neo `engine-t3` adapter and pinned Effect schemas rather than declaring the full private client runtime a stable SDK. Central docs were not changed by this helper.

**Contract test idea:** On every upstream ref update, verify the source SHA, protocol compatibility and local bundle; start a fresh isolated server, issue a scoped test session, register a fake ACP, create thread, dispatch, assert increasing event sequences and exact text chunks, decline and resolve one permission, verify run completed and `thread.settled` event after `thread.settle`. Also assert unauthenticated or wrong-version upgrades are rejected.
