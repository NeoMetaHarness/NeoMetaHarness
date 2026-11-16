# ADR 0001 · Desktop shell: Tauri 2 (system webview) instead of Electron

Status: **Accepted** · 2026-11-17 · Replaces "Electron" in Architecture v0.2

## Context
The Neo App is one React 19 + Astryx codebase for web, PWA and desktop. v0.2 picked Electron to match T3 Code, Hermes desktop and DSH desktop. The owner asked us to assess the approach used by [PandaCode](https://github.com/aicodeking/pandacode): Tauri 2 + Rust + the OS webview, plain TypeScript (no React), SQLite, no bundled Chromium and no resident Node server.

## What PandaCode's evidence actually shows
PandaCode's [T3 comparison bench](https://github.com/aicodeking/pandacode/tree/main/bench/t3-compare) streams a 50 KB reply into both UIs. **Both apps run in the same Chrome**, so the comparison measures the UI code, not the shell:

| W1 median | PandaCode | T3 Code |
|---|---:|---:|
| Main-thread task time | 2,947 ms | 8,332 ms |
| of which script | **288 ms** | **5,632 ms** |
| Layout / style / paint | ≈ same | ≈ same |
| JS heap after | 11.5 MB | 54.2 MB |

**Takeaway:** the rendering speed comes from the **UI architecture** (33 ms delta coalescing, no React/Effect work per delta, direct DOM updates), not from the webview. A system webview is *not* faster at rendering than Electron's Chromium; on Linux, WebKitGTK is usually slower. The real wins of the webview approach are **install size, RAM, startup time and security model**.

## Options

| | **Tauri 2 (system webview)** | Electron | PWA / browser only |
|---|---|---|---|
| Installer size | ~10–20 MB (+ gateway sidecar) | ~150–250 MB | 0 |
| Idle RAM | low (shared OS webview) | high (own Chromium + Node) | browser tab |
| Startup | fast | slower | fast |
| Rendering engine | WebView2/Chromium (Windows) · WKWebView/Safari (macOS) · WebKitGTK (Linux) | the same Chromium everywhere | user's browser |
| Consistency risk | **3 engines to test**; WebKitGTK weakest (WebRTC, perf) | none | per browser |
| Node in process | no; run the Neo Gateway as a **sidecar** | yes | n/a |
| Native features | tray, global shortcut, updater, single instance, deep links, dialogs, notifications (official plugins) | all, mature | limited |
| Security | capability-based permissions per window and command | broad by default; must be hardened | browser sandbox |
| Mobile | Tauri 2 can target iOS/Android (less mature; PandaCode itself uses Expo for mobile) | no | PWA |
| Extra language | Rust (thin shell only) | none | none |
| Upstream alignment | differs from T3/Hermes/DSH (Electron) | same | — |

## Decision
1. **Use Tauri 2 as the desktop shell.**
   - The Neo Gateway must run as a server anyway (web, PWA, remote, teams), so Electron's main advantage, Node in-process, doesn't apply.
   - The desktop app is the shared App bundle plus a thin Rust shell, plus an optional **gateway sidecar** for all-in-one installs. The sidecar is the Node gateway compiled to a single executable.
   - Rust is used **only** for shell concerns: tray, global launcher shortcut, updater, deep links, OS keychain, notifications, single instance. **No business logic in Rust**; that lives in the Gateway, so web and PWA get exactly the same features. This is the opposite of PandaCode, which puts its logic in Rust.
2. **Keep the App shell-agnostic.** Shell features sit behind `@neometaharness/shell` (`notify`, `tray`, `shortcut`, `openExternal`, `secureStore`, `fileDialog`, `update`, `deepLink`), implemented for `tauri` and `web` (PWA). An `electron` adapter stays possible if a WebKit blocker appears.
3. **Copy PandaCode's real speed lesson into the UI architecture.** The fast-path rule set:
   - Coalesce streamed deltas (~33 ms) in the Gateway before they reach the UI.
   - Keep hot streams (chat text, terminal, logs, tool output) **out of React state**. Use dedicated renderers (refs / direct DOM or fine-grained stores, xterm.js), with React and Astryx only for the surrounding UI.
   - Virtualize long lists. Budget the JS heap.
   - **Performance budgets in CI-free local checks:** a Neo port of PandaCode's bench (same W1 workload) run against T3 Code and PandaCode. Target: script time at most 2× PandaCode, and far below T3.
4. **Webview test matrix:** Playwright on Chromium + WebKit, plus a manual WebKitGTK smoke test per release. The screen viewer uses **RFB over WebSocket (noVNC) by default**, which works in every engine. WebRTC is optional where supported.

## Consequences
- ✅ Small, light desktop app; strong permission model that matches the extension permission model.
- ✅ The same App bundle serves web, PWA and desktop.
- ⚠️ Three rendering engines to QA, especially Linux WebKitGTK.
- ⚠️ Rust toolchain in the build (small surface).
- ⚠️ Diverges from the upstream desktops. This doesn't matter, since we embed none of their UIs.

## Related finding: Panda Router
[PandaOrchestrator](https://github.com/aicodeking/PandaOrchestrator) (MIT) is a local LLM router: a 31 MB ONNX task profiler + model-card matcher that picks the cheapest model likely to succeed in ~10–25 ms on CPU. It is available over HTTP, CLI, Python and MCP. This is directly useful:
- **v1:** a `models-router-panda` extension in the Model Hub. It picks the model per worker or bot turn (with an escalation ladder), local and private.
- **P8:** a starting point for Neo's small router model (retrain its success head on Neo's decision traces). Delegation decisions (accept / delegate where) stay with the super agent's Eval.

## PandaCode ideas worth borrowing (not code)
Account pools across subscriptions, tiled threads, a global quick launcher + menu-bar list of running agents, `/btw` side threads, turn checks (run tests after a clean turn), and a visual progress timeline.
