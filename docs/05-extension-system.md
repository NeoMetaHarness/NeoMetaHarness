# 05 · Extension System

Status: draft v0.1 · 2026-11-17

> Everything is an extension: easy to add features, safe to keep updating, and any extension can be switched on or off.

## 1. Goals
- **Add** a feature without touching the core or any other extension.
- **Toggle** any extension at runtime. Turning it off fully unwinds what it registered (routes, tools, UI, schedules, engine projections).
- **Upgrade** extensions independently. A broken extension degrades only itself.
- **Any language:** TypeScript in-process, or any language out-of-process over JSON-RPC / MCP.
- **Engines stay unmodified:** an extension may *project* parts of itself into engines (a Hermes plugin, a DSH plugin, a skill) through their public seams.

## 2. What is an extension

Even core features ship as extensions. Only the **kernel** (loader, permissions, settings, vault, event bus, Neo API) is not one.

| Kind | Examples | Can be turned off? |
|---|---|---|
| Engine | `engine-dsh`, `engine-hermes`, `engine-t3`, `engine-superagent` | Yes. Dependent features show "needs X" |
| Capability provider | `computer-local`, `computer-orgo`, `channel-whatsapp`, `memory-honcho`, `models-openrouter` | Yes |
| Feature | `agents`, `coding`, `skills-fabric`, `inbox`, `voice-xai`, `apps-composio`, `x-search` | Yes |
| UI-only | pages, panels, widgets, themes | Yes |
| Content | skill packs, agent templates, workflows, SOUL presets | Yes |

## 3. Manifest: `neo.extension.json`

```jsonc
{
  "id": "neo.computer-orgo",
  "version": "1.2.0",
  "publisher": "NeoMetaHarness",
  "displayName": "Orgo computers",
  "neo": ">=1.0 <2",                         // Neo API range
  "kind": ["capability"],
  "dependsOn": { "neo.computers": "^1" },    // other extensions (semver)
  "runtime": {                               // one of:
    "type": "process",                       // "cordis" (TS in-process) | "process" | "ui-only" | "content"
    "command": ["node", "dist/server.js"],   // any language: python, go, rust…
    "protocol": "jsonrpc+mcp"
  },
  "contributes": {
    "computerProviders": [{ "id": "orgo", "capabilities": ["screen","input","browserCdp","shell"] }],
    "settings": "schema/settings.json",       // JSON Schema → auto-rendered Astryx form
    "ui": { "routes": [], "slots": [{ "slot": "computer.detail.actions", "component": "ui/OrgoActions.js" }] },
    "tools": [], "skills": [], "channels": [], "modelProviders": [], "memoryProviders": [],
    "sources": [], "commands": [], "themes": []
  },
  "projections": {                           // installed into engines through their seams
    "hermes": { "plugin": "hermes/neo_orgo" },
    "dsh":    { "plugin": "dsh/neo-dsh-orgo", "profiles": ["neo-coding", "neo-superagent"] }
  },
  "permissions": {
    "network": ["api.orgo.ai"],
    "vault": ["ORGO_API_KEY"],
    "engines": ["hermes", "dsh"]
  },
  "activation": ["onComputerProvider:orgo"]
}
```

## 4. Lifecycle

```
discover → install → verify → (review permissions) → enable → running ⇄ disabled → upgrade → uninstall
```
- **Verify:** checksum or signature, manifest schema, Neo API range, dependency resolution, security scan (Hermes skills-guard for skill content).
- **Enable:** the kernel mounts a TS extension as a Cordis plugin, or spawns a process extension with only its permissions. It then applies projections (installs the Hermes plugin, adds the DSH patch row) and registers its contributions.
- **Disable:** Cordis effects unwind, the process stops, projections are removed, contributions are unregistered, and dependents are marked degraded. Extension data and the selected upgrade persist. The owner-only `extensions.uninstall` disables the extension and clears the managed selection. A subsequent enable uses the bundled version when available.
- **Upgrade:** the owner-only `extensions.upgrade` takes the enabled extension id, an absolute candidate directory, and an `integrity` digest. The kernel verifies the copy in `<dataDir>/extensions/generations/<id>@<version>/`, seals it read-only, validates identity and dependencies, and health-checks the candidate before the atomic switch. A failed candidate is disposed and the old version stays live. A committed upgrade emits `extension.upgrade` and restarts running dependents that use its services.
- **Digest:** use `extensionIntegrity(directory)` from `@neometaharness/kernel`. It returns the lowercase hexadecimal SHA-256 of the UTF-8 `JSON.stringify` array of records sorted by relative path in UTF-16 code unit order. Paths use `/`. Records are `[path,"directory"]`, `[path,"file",lowercaseSha256OfFileBytes]`, or `[path,"link",relativeTarget]`. Link targets use `/` and must stay inside the tree. The digest is independent of file modes and timestamps.
- **Managed runtimes:** Cordis uses a JavaScript entry with module resolution pinned to the verified copy and Node built-ins. A process command starts with `node` or `python`, followed by an in-tree script and optional in-tree path arguments. The Gateway uses its own Node executable and the absolute Python executable configured by the operator in `NMH_EXTENSION_PYTHON`. Python bytecode writes are disabled. Process route calls default to 30 seconds, with per-route overrides in the manifest's `runtime.routeTimeoutMs` map and cancellation at the drain deadline.
- **Restart:** the selected generation and digest are persisted in SQLite. A verified kernel-owned copy can run without a bundled version. If the copy is unavailable or changed, the Gateway reports the extension as degraded and uses the bundled version when available. An equal or newer bundled version takes precedence.
- **Drain:** requests already dispatched keep their old generation until completion. Returned async iterators retain that generation until closed. `ctx.onDrain(close)` closes extension-owned sockets/connections at retirement; `ctx.effect` remains responsible for final resource cleanup. After the configurable drain timeout (default 5 seconds), the route's `signal` aborts and streams are closed; process shutdown then terminates remaining process-owned sockets. In-process handlers must honor cancellation and register their resource cleanup.
- **Upgrade settings:** each generation owns its resolved settings and schema snapshot, including candidate-version defaults and vault-backed secrets. Staging does not replace serving settings; publication switches them with the routes, and a rejected candidate leaves the old snapshot intact. Settings saves are serialized with upgrades and update only the serving generation. Draining requests keep their old settings object.
- **Workspace settings (P1-13):** settings and secret settings belong to a workspace. `ctx.inject('settings')` reads the workspace of the request being served (the Gateway runs each request in its caller's workspace); background work uses `ctx.inject('settingsFor')(workspaceId)`. Server-mode work outside any workspace sees schema defaults and no secrets. Saves are validated against the manifest schema (own properties only; the string "false" is not a boolean). Secrets are stored at vault scope `{ kind: 'engine', workspaceId, subjectId: <extension id> }`, writable only by an admin of that workspace. Desktop is one workspace. Settings stored before P1-13 move into the desktop workspace, or in server mode into the bootstrap workspace (the first created) once it exists.
- **Workspace configuration outside kernel settings:** an extension that keeps its own per-workspace configuration maps the caller's workspace through the Gateway's `workspaceDirectory` service (desktop: always `'default'`). Model Hub providers, keys, roles and overrides, and Panda router settings, are per workspace this way; the bootstrap workspace starts from the configuration stored before P1-13. Engines pass the workspace of the work they serve to `modelHub.resolve`.
- **Deployment-level, not per workspace:** the Hermes runtime and what is bound to its profiles (profile API credentials, channel credentials and sender lists, Hermes model projection, which uses the deployment's `'default'` Model Hub configuration), the GitHub source and upstream routine (deployment-level Inbox items), the deployment accept mode, and skills-registry evaluation. In server mode only the deployment owner (P1-14) manages the deployment's model and router configuration, through `x.models.deployment.*` and `x.models-router-panda.deployment.settings.*`.
- **Upgrade data:** the Gateway's `extensionDataDir` and vault service/scopes retain their identity. Write to the stable per-extension `dataDir`, available in managed Cordis via `ctx.inject('dataDir')` and in process `initialize` alongside `projectionDir`. Staging reuses existing settings and projections. Concurrent versions must use compatible storage formats and private staging resources. Keep live singleton mutations and irreversible data migrations out of staged activation.
- **Health:** each extension exposes `health()`, logs, metrics and a kill switch on the **Extensions** page.

## 5. Contribution points (v1)

| Point | Interface owner | Purpose |
|---|---|---|
| `computerProviders` | `neo.computers` | Screens and machines (see Architecture §6) |
| `channels` | `neo.channels` | Messaging platforms (usually a Hermes platform plugin projection) |
| `modelProviders` | `neo.models` | Model / subscription backends + route roles |
| `memoryProviders` | `neo.memory` | Memory backends (L1, Honcho, others) |
| `skills` | `neo.skills` | Skill packs into the registry |
| `tools` | kernel | MCP tools exposed to engines and the super agent |
| `sources` | `engine-superagent` | Superagent Source kinds |
| `ui.routes` / `ui.slots` | `@neometaharness/ui` | Pages and named slots (bot.detail.tabs, computer.detail.actions, settings.sections, inbox.cards, coding.thread.panels…) |
| `settings` | kernel | JSON Schema → generated Astryx forms |
| `commands` | kernel | Command palette, `neo` CLI, chat slash commands |
| `themes` | `@neometaharness/ui` | Astryx CSS-variable themes |

## 6. UI rules (one product feel)
- Extension UI **must** use `@neometaharness/ui` (Astryx + Neo patterns). Raw component libraries are rejected at review.
- UI bundles are ES modules loaded into named slots with shared React and Astryx (import map), so there is one copy of each.
- Settings pages are generated from the JSON Schema by default. Custom UI is the exception.

## 7. Compatibility and safety
- The **Neo API is semver'd**. Breaking changes need a major version and a deprecation window of at least one minor release.
- **Contract tests** per contribution point; the official extensions are the reference test suite.
- **Isolation:** third-party extensions run as process extensions by default; in-process Cordis is for first-party or trusted extensions.
- **Feature flags:** every extension can ship experimental features behind flags, managed in the same Settings UI.

## 8. Distribution
- Official extensions live in the product monorepo under `extensions/`.
- The registry index lives in **NeoMetaHarness-Extensions** (`machine/extensions-registry.json`). Sources: registry, git URL, npm, PyPI, or a local path.
- `neo ext list | install | enable | disable | upgrade | remove | new` (scaffold from a template: TS-cordis, TS-process, Python-process, UI-only, content).

## 9. Adding a route

Every route exposed by Neo, whether an oRPC contract procedure in `@neometaharness/contracts` or a plain HTTP extension route, must have an explicit policy in [the centralized policy table](../apps/gateway/src/policy.ts). Policy levels are `viewer`, `member`, `admin`, `owner`, `deployment-owner`, and `internal`. Server-mode kernel upgrades and uninstalls require the deployment owner.

1. **Contract routes:** When adding a new leaf procedure to `neoContract` (for example, `x.new-engine.action` or `agents.features.do`), add a corresponding entry in `CONTRACT_POLICY`:

   ```ts
   'x.new-engine.action': 'member',
   ```

   The [contract-coverage test](../apps/gateway/test/policy.test.ts) walks `neoContract` and asserts a strict 1:1 mapping in both directions. Omitting a policy entry or adding a dangling entry fails `pnpm --dir apps/gateway test`.

2. **Route authorization in handlers:** All procedure handlers must invoke `authorize(path, context)` before accessing extension state or delegating to an engine:

   ```ts
   action: os.x['new-engine'].action.handler(async ({ input, context }) => {
     authorize('x.new-engine.action', context);
     return invokeEngine('action', input);
   }),
   ```

   This rejects unauthenticated callers (401) and unauthorized callers (403) before checking whether the extension is disabled or degraded. Input schemas still validate at the oRPC boundary.

3. **Plain HTTP extension routes:** Document the policy in `HTTP_ROUTE_POLICY`, which is included in `ROUTE_POLICY`. The current `/x/*` fallback requires `viewer` access; routes that perform actions need an appropriate stronger check. Token-protected internal endpoints verify their own scoped credentials; `authorize()` rejects user RPC calls to an `internal` policy.
