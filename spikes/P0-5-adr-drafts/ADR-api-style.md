# P0-5 ADR draft — Neo API style (Gateway ↔ App)

Status: **PROPOSED**; PM review required. Date: 2026-11-17.

## Context

Neo Gateway exposes one versioned, typed, schema-first contract from `packages/contracts` to web, PWA, Tauri webview and remote clients. It needs bidirectional WebSocket transport, ordered streaming subscriptions, runtime validation and TypeScript inference without generation. Extensions will register namespaced APIs through the Gateway. T3 Code v0.1.9 internally uses Effect RPC over WebSocket (see pinned `packages/contracts/src/rpc.ts` and `apps/server/src/ws.ts`), but Neo owns its separate Gateway ↔ App protocol.

The comparison deliberately benchmarks the same subscription: client sends `{count:2000}`; server streams ordered `{kind:'delta',seq:1..2000,text:'x'}` followed by exactly one `{kind:'done',seq:2000,text:''}`. Both clients check every sequence and terminal frame.

## Options

| Criterion | Effect RPC 4.1.2 | oRPC 1.16.2 | tRPC v11.28.3 |
| --- | --- | --- | --- |
| Shared definition | `RpcGroup` + Effect `Schema`, schema-first | `@orpc/contract` + Zod, contract-first | `initTRPC` router/procedures, inferred `AppRouter` type; chiefly implementation-first |
| Subscriptions | Typed `stream:true` on Rpc; tested WebSocket | Typed `eventIterator` output; tested `RPCHandler`/`RPCLink` WebSocket | Typed subscriptions over `wsLink` or SSE; **not benchmarked** |
| Browser / Tauri webview | Standard WebSocket client; browser esbuild succeeded | Standard WebSocket client; browser esbuild succeeded | TypeScript clients and WebSockets/SSE documented; not tested here |
| Remote client | WS transport possible; server auth/reconnect untested | WS transport possible; server auth/reconnect untested | WS/SSE plus tracked-event resume documented |
| Code generation | None | None | None for TS clients |
| Complexity | Effect layers, scopes, fibers, RPC protocol and Effect Schema | Contract + handler + link; async generator and Zod | Router and type-import coupling to server application |
| Existing upstream seam | Mirrors T3's implementation style | Neo↔T3 adapter must translate protocols (already necessary) | Neo↔T3 adapter must translate protocols (already necessary) |
| Local 2,000-event median completion | **9.46 ms** | 48.46 ms | Not measured |
| Local median request→first delta | **7.67 ms** | 39.96 ms | Not measured |
| Browser client bundle (minified / gzip) | 265,547 B / **87,020 B** | 308,049 B / **64,816 B** | Not measured |

Reference documentation: [oRPC v1 WebSocket RPC link](https://v1.orpc.dev/docs/client/rpc-link), [oRPC v1 event iterators](https://v1.orpc.dev/docs/event-iterator), [tRPC v11 subscriptions](https://trpc.io/docs/server/subscriptions). The shipped spike explicitly uses oRPC **v1** APIs; do not substitute newer major-version documentation or APIs.

## Decision (proposed)

Use **oRPC contract-first** with Zod schema modules in `packages/contracts` for the Gateway ↔ App boundary, typed `RPCHandler`/`RPCLink` over WebSocket for subscriptions and the same contracts over HTTP for ordinary request/response operations. Use namespaced contract groups for extensions. Keep the T3 Effect RPC client behind the `engine-t3` Gateway adapter; its wire contract need not dictate Neo's public API.

Why oRPC despite Effect's faster loopback measurements: the contract-first separation is explicit, the proof uses simpler implementation and client setup, and the **compressed** client entry is ~22 kB smaller. On the intended remote path, network conditions, authentication and Gateway batching are likely more important than these isolated localhost times; that remains a hypothesis, not a measurement. Effect RPC is the fallback if production tests reveal a measurable throughput or latency limit.

Reject tRPC for this decision because Neo requires a standalone shared contract and independently replaceable server implementations; tRPC's normal router-first typing couples the contract to the server router type. tRPC meets the streaming and TS/no-codegen requirements, so this is a fit judgment rather than an assertion that it cannot stream.

## Consequences

- Share only Zod contracts and client transport modules with the browser; never bundle Node server handlers into the App. Lazy-load the streaming client if it is not needed at startup.
- Transport authentication, tenant isolation, extension route activation/unregistration, cancellation, slow-client backpressure, reconnect/resume, error frames, version negotiation and upgrade behavior require later contract tests. None were proven here.
- Measure real Gateway coalescing and representative concurrent streams before setting a performance budget; 2,000 immediate deltas are a synthetic worst case for unbatched delivery, not a UI benchmark.
- An Effect adapter remains necessary for the separate T3 server at the pinned revision. Do not fork upstream merely to change transports.

## Evidence

In `spikes/P0-5-adr-drafts` (PowerShell):

~~~powershell
$env:NMH_UPSTREAM_CACHE='C:\Users\Neo\Desktop\nmh-upstream-cache'
pnpm.cmd install --frozen-lockfile  # dependency restore, if needed
node upstream-path.test.mjs
node api-benchmark.mjs
~~~

Observed on **Windows, Node v22.23.2**, WebSocket loopback `127.0.0.1`, **one warm-up + five measured trials** per implementation. Timing starts before client WebSocket setup; first-delta timing stops at the first stream frame and completion at return after the terminal frame. Each sample includes 2,000 ordered deltas plus one done event. Browser bundles from esbuild `platform:browser`, `format:esm`, `target:es2022`, `minify:true`, `treeShaking:true`; gzip uses Node `gzipSync`. A trivial baseline minifies to 42 B. Figures describe client entries plus whatever runtime dependencies esbuild retained after tree-shaking (type-only schema references may be removed), not guaranteed incremental bytes inside a production App. Compile-time TypeScript inference was assessed from library APIs, not compiled in this JavaScript-only runtime proof.

~~~text
effect-ws PASS runsMs=[21.23,9.54,9.06,9.46,8.76]
  firstDeltaMs=[11.79,7.76,7.50,7.67,7.25]
  medianCompletionMs=9.46 medianFirstDeltaMs=7.67
  bundleBytes=265547 bundleGzipBytes=87020
orpc-ws PASS runsMs=[81.45,51.26,48.46,47.55,47.08]
  firstDeltaMs=[66.10,42.22,39.96,39.43,39.78]
  medianCompletionMs=48.46 medianFirstDeltaMs=39.96
  bundleBytes=308049 bundleGzipBytes=64816
baselineBytes=42 node=v22.23.2 deltas=2000 trials=5 warmup=1
API_BENCHMARK PASS
~~~

Effect's HTTP layer emitted informational interruption records (status `503`) when each test closed its scoped WebSocket server. All 2,001 events had been received and validated beforehand. These shutdown logs deserve a lifecycle check before production use; they do **not** establish a failed RPC request in this proof. No real model, paid account, user credential, or external host was used.

Minimum next acceptance test: contract serialization snapshot + ordered stream over browser WebSocket; assert scoped auth, cancellation, reconnect, extension unmount, and 100 concurrent subscribers in a real Gateway.
