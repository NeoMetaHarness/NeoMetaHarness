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
- **Disable:** Cordis effects unwind, the process stops, projections are removed, contributions are unregistered, and dependents are marked degraded. The extension's data is kept.
- **Upgrade:** blue/green. Start the new version, run its health check, then switch. If the check fails, roll back automatically.
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
