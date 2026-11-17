# P0-3d DSH Cordis provider + SDK JSON-RPC seam

Verdict: **WORKS WITH WORKAROUND**

Question: Can Neo mount a Cordis plugin without editing DSH, own `computerUse` and `browserUse` registrations, and drive a real SDK session over JSON-RPC?

Pinned ref: `deepseek-ai/deepseek-harness@0.2.2-rc.1` (published `@deepseek-ai/dsh@0.2.2-rc.1`, `@deepseek-ai/cordis@4.1.0`).

Seam:
- `packages/computer-use/computer-use/src/index.ts` and `packages/browser-use/browser-use/src/index.ts`: exclusive named registries, effect disposal.
- `packages/sdk/protocol/src/types.ts`, `packages/sdk/server/src/server.ts`, `packages/sdk/protocol/src/transport.ts`: newline-delimited JSON-RPC handshake, session prompt, notifications, wait, shutdown.
- `packages/bundle/sdk-app/cordis.patch.yml`, `apps/cli/src/args.ts`: `dsh --profile sdk --patch path` composes an overlay. `neo-providers.mjs` is an independently loaded Cordis plugin, not a DSH source edit.

Reproduce on Windows / PowerShell:

```powershell
cd C:\Users\Neo\Desktop\nmh-wt\codex\spikes\P0-3d-dsh-seams
pnpm.cmd install --ignore-scripts --frozen-lockfile
pnpm.cmd test
```

The test script spins up a real **published DSH CLI** with an isolated temporary `DSH_HOME` under this spike’s ignored `.cache/`, a disposable workspace, a patch and a fully scripted LLM adapter. No credentials or paid model are used. Node tested: `v22.23.2` (upstream declares >=24.9.0). The probe resolves the registry modules to file URLs because bare package names are not resolved from the isolated profile's home. JSON-RPC stdout is parsed separately from diagnostics on stderr. The temporary home is removed and child process must exit 0.

Evidence (trimmed from `pnpm.cmd test`, 2026-11-17):

```text
INIT {"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}}
PROMPT {"messageId":"a34f5c1b-215e-4570-9314-084d9f43f7f7"}
WAIT settled
EVENTS [...,"turn/start",...,"assistant/message",...,"turn/end"]
STATUS [{"sessionId":"neo-sdk-smoke-1","status":"running"},{"sessionId":"neo-sdk-smoke-1","status":"idle"}]
ASSISTANT_EVENT {"type":"assistant/message",...,"content":[{"type":"text","text":"Neo scripted DSH SDK reply."}],...,"stream":[{"type":"chunk",...},{"type":"text-chunks",...,"texts":["Neo scripted ","DSH SDK reply."]},...]}
PASS live SDK initialize/prompt/events/wait
SHUTDOWN acknowledged
PROCESS {"code":0,"signal":null}
STDERR_TAIL NEO_REGISTRY computer=neo-computer-stub browser=neo-browser-stub
PASS REGISTRY computerUse duplicate rejected / dispose released / re-register succeeded; browserUse duplicate rejected / dispose released / re-register succeeded; Cordis plugin unload released both provider slots
```

The registry conflict/disposal check runs against the **published real Cordis services**, with provider ownership exercised through a dynamically loaded Cordis plugin. The SDK test runs the real DSH SDK profile and validates prompt delivery, the persisted assistant event with streamed text segments, idle notification, and clean shutdown.

Risks:
- **Registries only reserve a provider name**. No actual screen action, browser action, or computer transport is implemented by this spike. Neo must supply tool implementations separately and bind them to the selected provider.
- Isolated `DSH_HOME` cannot resolve npm packages installed only in this spike by bare name: initial boot reported `ERR_MODULE_NOT_FOUND` and `no adapter registered`. The probe supplies file URLs for the pinned modules and our plugin.
- The published CLI was exercised on Node 22.23.2, below upstream's declared Node >=24.9.0. Repeat on supported Node >=24.9.0 during integration qualification.
- Real-world model/network providers, approval flow, disconnect/reconnect and concurrent sessions are not covered. Preserve stdout for wire frames and stderr for diagnostics; future upstream bumps may alter plugin load order, JSON-RPC events, or provider interfaces.

Architecture impact: Keep `engine-dsh` as a profile-patched, unmodified DSH engine in `docs/02-architecture.md` sections 3 and 6. Add a packaging rule in `docs/05-extension-system.md`: resolve plugin entry URLs relative to the **Neo extension's install root** (or provision the engine profile's own dependencies), and let the provider extension manage owned tools plus provider slot lifecycle.

Contract test idea: Launch the pinned CLI from an empty temporary home; require both registry names, duplicate rejection, unload cleanup, `initialize`, `session/prompt`, a `session.event` assistant stream containing the deterministic text, `session/wait`, idle, `shutdown` and clean exit. Keep the protocol result independent from stderr.
