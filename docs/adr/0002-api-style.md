# ADR 0002 · Neo API style: oRPC contract-first

Status: **Accepted** · 2026-11-18 · Evidence: [P0-5 drafts](../../spikes/P0-5-adr-drafts/ADR-api-style.md) (Codex; reproduced by the PM twice)

## Context
The Gateway ↔ App boundary (`packages/contracts`, [docs/02 §4](../02-architecture.md#4-the-neo-gateway)) must be schema-first and need no codegen. It must stream (subscriptions), and work from the browser, the Tauri webview and remote clients. Neo is "agnostic of everything", so process extensions in Python or Go, and third-party clients, must be able to use it too.

## Options (measured on the same 2,000-delta ordered stream, Windows, Node 22, loopback)
| | Effect RPC 4.1.2 (what T3 uses) | **oRPC 1.16.2** | tRPC 11.28.3 |
|---|---|---|---|
| Contract | `RpcGroup` + Effect Schema | `@orpc/contract` + Zod, standalone | inferred from the server router type |
| Connect + first delta (median) | 7.8 ms | 44 ms | not measured |
| 2,000 deltas after first delta | ≈ 2 ms | ≈ 8 ms | not measured |
| Client bundle, gzip | 87 KB | **65 KB** | not measured |
| OpenAPI from the same contract | no | **yes** (3.1.1, 3.6 KB for the stream route) | via a third-party plugin |
| Complexity | Effect layers, fibers, scopes | contract + handler + link | router-type coupling |

## Decision
Use **oRPC v1, contract-first, with Zod schemas** in `packages/contracts`. Ordinary calls go over HTTP and streams over one long-lived WebSocket (`RPCHandler` / `RPCLink`). Extensions get namespaced contract groups (`/x/<extension>/…`). The same contracts emit **OpenAPI** for HTTP/SSE, which is the documented API for non-TS process extensions and outside clients.

T3's Effect RPC stays inside `engine-t3` ([spike a](../../spikes/P0-3a-t3-headless-client/README.md)). An engine's wire protocol never becomes Neo's public API.

## Why not the faster option
Effect's lead is connection setup (about 36 ms once per connection). Stream throughput after that is the same order on both. The App keeps one connection open and the Gateway coalesces deltas (33 ms), so the gap does not reach users. Effect would also tie every extension author to the Effect runtime. If production tests ever show a real limit, Effect RPC is the fallback behind the same contract package.

## Consequences
- Only contracts and the client link ship to the browser. Lazy-load the stream client if it isn't needed at startup (bundle budget from ADR 0001 / spike g).
- OpenAPI describes HTTP/SSE, not WS framing. The WS transport is documented separately.
- Still to prove in P1 contract tests: auth on the socket, tenant isolation, cancel, reconnect/resume, slow-client backpressure, version negotiation, extension route mount/unmount.
- Pin oRPC exactly. A major upgrade goes through an ADR amendment.
