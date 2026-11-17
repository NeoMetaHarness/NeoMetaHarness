# P0-3g Astryx in Tauri + PWA

Verdict: **WORKS (web + PWA)** · **Tauri half pending**: Rust + MSVC Build Tools aren't installed yet (needs the user's OK for a ~5–7 GB install).
Question: Can the one Neo App run on Astryx (React 19 + StyleX) as a web app and installable PWA, fast enough to meet ADR 0001's streaming budget, and inside a Tauri 2 shell?
Pinned ref: `@astryxdesign/core@0.7.16`, `@astryxdesign/theme-neutral@0.7.16`, React 19, Vite 7. Chrome 1xx headless on Windows 11.

## What was built
- A Vite + React 19 app using Astryx `Theme`, `AppShell`, `SideNav`, and the **Astryx Chat kit** (`ChatLayout`, `ChatMessageList`, `ChatMessage`, `ChatMessageBubble`, `ChatComposer`) plus `Markdown`.
- PWA: `manifest.webmanifest`, an icon, and a cache-first app-shell service worker (`public/sw.js`).
- `bench/run.mjs`: a streaming-render bench over raw CDP (Node 22 `WebSocket`, no Playwright). Same workload shape as PandaCode's W1: a seeded ~50 KB markdown reply, 2,001 × 25-byte deltas over 16 s, a fresh Chrome per run, mode order alternating per round. It measures `TaskDuration` / `ScriptDuration` / layout / style deltas, heap after GC, and delivery lateness, and **checks that every mode renders an identical final structure**.
- `bench/pwa-check.mjs`: manifest, service worker and offline reload, checked over CDP.

## Evidence

### Typecheck + build
```
npx tsc -p .            → no errors
pnpm build              → dist/assets/index-*.js 1,117 KB (368 KB gzip), CSS 307 KB (49 KB gzip)
```

### PWA (`node bench/pwa-check.mjs`)
```
{ "manifestErrors": 0, "manifestUrl": ".../manifest.webmanifest", "swState": "activated", "offline": "app shell rendered" }
```

### Streaming render (`node bench/run.mjs --runs 5 --ms 16000`)
Median of 5 cold runs per mode (fresh Chrome each run, order alternating), 2026-11-17. Raw data: `bench/results/2026-11-17.json`.
**The final rendered structure was identical in all 25 runs**: `h2:74 li:219 pre:73 table:73 blockquote:73 a:73`.

| Mode | Task ms | Script ms | Layout ms | Style ms | Wall ms | Last delivery → paint | Worst lateness | UI updates | Heap after GC |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| naive | 10,323 | 5,485 | 1,835 | 401 | 16,135 | 129 ms | 25 ms | 2,001 | 17.7 MB |
| coalesced | 8,125 | 3,654 | 1,752 | 398 | 16,121 | 128 ms | 21 ms | 339 | 17.6 MB |
| dom | 2,035 | 376 | 1,002 | 41 | 16,239 | 244 ms | 13 ms | 362 | 15.5 MB |
| blocks | 6,953 | 1,929 | 2,456 | 159 | 16,037 | 40 ms | 57 ms | 286 | 29.4 MB |
| **blocks-sections** | **5,022** | **617** | 2,212 | 98 | 16,034 | **29 ms** | 47 ms | 319 | 19.1 MB |

`blocks-sections` versus `naive`: script **−89%** (617 vs 5,485 ms), main-thread task time **−51%**, fastest final paint, and formatted output while streaming. Layout (2.2 s) is now the largest cost, so the next optimization is `content-visibility: auto` / containment on finished sections. Note: a 10 s PWA check overlapped one round; these are medians of 5.

Modes:
| Mode | What it does |
|---|---|
| naive | React `setState` on every delta → `<Markdown isStreaming>` |
| coalesced | Deltas batched 33 ms → `setState` → `<Markdown isStreaming>` |
| dom | Deltas appended to a raw Text node outside React; Markdown rendered once at the end (plain text while streaming) |
| blocks | Finished blank-line blocks each render once as memoized `<Markdown>`; the open tail is a raw Text node |
| **blocks-sections** | The same, but blocks close only before a heading: fewer, larger Markdown mounts |

## Findings
1. **Astryx works for the Neo App.** It has 174 components, including a chat kit, AppShell, SideNav, CommandPalette, Table and Toast. Most App surfaces need no custom components.
2. **Batching alone is not enough.** `<Markdown isStreaming>` re-parses the whole growing reply on every update, so the cost grows with reply length. Coalescing to 33 ms cut script time by only ~29%.
3. **Per-block streaming meets the budget with formatted output.** In `blocks-sections`, finished sections are memoized Markdown and only the open section is a raw text node. Script time drops 89% versus naive (617 vs 5,485 ms), within 2× of plain DOM, and the user still sees formatted markdown while it streams. This is the recommended pattern for every Neo stream view (chat, tool output, logs).
4. **Many tiny Markdown instances cost memory.** Splitting at every blank line created ~370 Markdown instances, about 29 MB of heap, more layout work and *worse* lateness. Split at structural boundaries instead (headings or larger), or merge small blocks.
5. **Bundle size needs code splitting.** 1.1 MB of JS from one entry. The Neo App must lazy-load Markdown, Chat and heavy pages, with a budget in `neo check`.
6. **pnpm 12 blocks dependency build scripts.** Astryx's postinstall only prints an "init" hint, so it stays blocked. esbuild works through its platform package.
7. **Bench gotcha.** Headless Chrome throttles timers in background targets, and chained `setTimeout` calls clamp at 4 ms. Without `--disable-background-timer-throttling` and a fixed-timeline scheduler, results are invalid (a 4 s stream took 20 s). Fixed in the bench.

## Risks
- Astryx is **beta** (0.7.x). Pin it exactly and bump weekly behind the visual check.
- The `Markdown` streaming internals may change; our per-block pattern only relies on the public `Markdown` component.
- Numbers come from one Windows machine in headless Chrome. They are a regression baseline, not an absolute comparison with PandaCode (different machine).

## Architecture impact
- docs/02 §2 / ADR 0001 "fast-path rules": make **per-section memoized Markdown + raw tail text node** the standard stream renderer (`@neometaharness/ui` `StreamView`). It replaces "keep hot streams out of React state" as the concrete rule.
- PRD APP-7: express the budget against our own bench: `blocks-sections` script time ≤ 15% of `naive` and heap ≤ 25 MB on W1. Add a JS bundle budget: initial chunk ≤ 300 KB gzip.

## Contract test idea
`bench/run.mjs --runs 3 --modes naive,blocks-sections`, run in `neo check:perf` after each Astryx bump. It fails if the structure differs, if the `blocks-sections` / `naive` script ratio goes above 0.2, or if heap goes above 25 MB.

## Still to do (Tauri half)
Install the Rust toolchain + MSVC Build Tools (user approval), then: `tauri init` around `dist/`, measure installer size, idle RAM and cold start, and run the same bench inside WebView2 through its CDP port.
