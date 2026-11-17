# P0-3a T3 headless client

**Verdict: BLOCKED** (for the requested live end-to-end test; source-contract checks work)

**Question:** Can a non-T3 React app drive a pinned T3 **server** to create threads, send turns, stream events, and answer approvals using `packages/contracts` and `packages/client-runtime`? Are those packages public or stable?

**Pinned ref:** T3 Code `v0.1.9`, commit `24e77473ecf41bc1f7142529c7911c1c1aae1d76`, source checkout `C:\Users\Neo\Desktop\nmh-upstream-cache\t3code@v0.1.9`. The spike checks the exact SHA before bundling.

**Seam:**

- `packages/contracts/src/environment.ts`: `ORCHESTRATION_PROTOCOL_VERSION = 2`.
- `packages/contracts/src/orchestrationV2.ts`: `OrchestrationV2RpcSchemas.dispatchCommand` accepts `thread.create`, `message.dispatch`, and `runtime-request.respond`; `subscribeThread` takes `threadId` and yields `snapshot`, `event`, or `synchronized` items. Commands return an acknowledged `sequence`.
- `packages/client-runtime/src/connection/compatibility.ts`: `appendOrchestrationProtocol()` adds the version query parameter.
- `packages/client-runtime/src/rpc/protocol.ts`: `makeWsRpcProtocolClient` builds an Effect RPC client; the full runtime depends on the upstream connection/session lifecycle and Effect layers (`packages/client-runtime/src/rpc/session.ts`). This is not a standalone fetch/JSON-RPC client.
- `packages/client-runtime/src/operations/commands.ts`: upstream React-facing operations map thread creation, messages, and approval responses into these commands; this full operations module was not bundled by the spike.
- `apps/server/src/ws.ts`: `/ws` enforces protocol compatibility and calls `EnvironmentAuth.authenticateWebSocketUpgrade(request, "rpc")` before Effect RPC WebSocket upgrade.
- `packages/contracts/package.json` (`version: 0.1.8`) and `packages/client-runtime/package.json`: **both** `private: true`; exports are upstream source/workspace dependencies, not a published stable SDK.

**Evidence (Windows PowerShell, Node `v22.23.2`, T3 CLI `v0.1.9`):**

The local probe bundles the pinned upstream contract files and two client-runtime modules using `esbuild`, resolves Effect from this spike's own `node_modules`, checks the source SHA, then decodes real Effect schemas. Install with `npm.cmd ci` in this directory.

```text
PS spikes/P0-3a-t3-headless-client> npm.cmd run probe
source_contract=PASS protocol=2 dispatchCommand subscribeThread
client_runtime=PASS compatibility + Effect RPC client factory import
command_schemas=PASS thread.create message.dispatch runtime-request.respond subscribeThread synchronized reject-invalid
Process exited with code 0
```

Started a separate, local T3 desktop-mode server on `127.0.0.1:43871`, with state under this spike's ignored `.cache/t3state` (never accessed the user's existing T3 instance):

```powershell
t3.cmd serve --mode desktop --host 127.0.0.1 --port 43871 --base-dir 'C:\Users\Neo\Desktop\nmh-wt\codex\spikes\P0-3a-t3-headless-client\.cache\t3state' --no-browser
npm.cmd run probe:live
```

```text
source_contract=PASS protocol=2 dispatchCommand subscribeThread
client_runtime=PASS compatibility + Effect RPC client factory import
command_schemas=PASS thread.create message.dispatch runtime-request.respond subscribeThread synchronized reject-invalid
live_protocol_check=PASS missing_version_status=426 versioned_status=401
live_rpc=BLOCKED auth=missing_credential
Probe exits nonzero (2) on this expected authentication block.
```

Direct HTTP evidence confirms the boundary: `GET /ws` returned `426` with `code=orchestration_protocol_incompatible` and server version `2`; `GET /ws?orchestrationProtocol=2` returned `401` with `code=auth_invalid`, `reason=missing_credential`. The isolated server was subsequently stopped; the port no longer accepts connections. The one-time pairing URL/token produced by T3 was not recorded here.

**Not proven:** No authenticated RPC session; no real thread creation, turn dispatch, subscription stream, or approval response. The passing schema checks establish the command/stream shapes, **not** live delivery. Completing E2E requires a properly paired, authorized test client/session and server; do not assume a raw WebSocket can bypass pairing.

**Risks:** Both runtime packages are private and rely on `workspace:*` modules; importing the complete client requires additional upstream dependencies, Effect runtime layers, and connection lifecycle. Protocol version `2` and method names are pinned to this source revision, with no demonstrated compatibility guarantee across T3 upgrades. The spike builds only the minimal source modules named above. Real command authorization, session recovery, event ordering, and UI consumption remain unverified.

**Architecture impact:** **Change `docs/02-architecture.md` engine table (T3 row) and Coding section**: treat T3 as an authenticated, version-pinned Effect WebSocket RPC integration behind a Neo `engine-t3` adapter. Remove the implied stable standalone SDK guarantee from `packages/contracts` + `packages/client-runtime`; they are private source packages. Require proper T3 pairing/session setup, a deliberate dependency policy, and a passing authenticated end-to-end proof before claiming full Neo App coding control. No central docs were changed by this helper.

**Contract test idea:** On every T3 ref change, assert the pinned SHA/version, build the selected source imports, validate `thread.create`, `message.dispatch`, `runtime-request.respond`, and `subscribeThread` input/output with upstream schemas, and verify incompatible/missing credentials return controlled failures. An authenticated ephemeral-server test should additionally create a thread, dispatch a turn, consume ordered events, and decline a pending approval; this last part is a follow-up gate, not a passing check in this spike.

**Reproduce:** `npm.cmd ci` followed by `npm.cmd run probe`. `npm.cmd run probe:live` also requires the isolated server running; without a paired client it intentionally exits `2` when the server rejects authentication.
