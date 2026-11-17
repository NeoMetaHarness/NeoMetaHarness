# P0-5 ADR draft — Neo API style (Gateway ↔ App)

Status: **PROPOSED**; PM review required. Date: 2026-11-18.

## Context

The Neo Gateway needs one versioned, schema-first contract in `packages/contracts` for browser, PWA, Tauri and remote clients, including ordered streaming subscriptions and runtime validation without TypeScript code generation. Non-TypeScript process extensions and third-party clients should also be able to discover the public API. T3 Code v0.1.9 uses Effect RPC internally; Neo's Gateway owns a distinct public protocol.

Our localhost proof sends `{count:2000}`, receives 2,000 ordered `{kind:'delta',seq,text}` events and one terminal `{kind:'done',seq,text}`, and checks sequence numbers and the terminal frame. Every measured call opens a new WebSocket.

## Options

| Criterion | Effect RPC 4.1.2 | oRPC 1.16.2 | tRPC 11.28.3 |
| --- | --- | --- | --- |
| Contract | `RpcGroup` + Effect Schema | `@orpc/contract` + Zod; standalone definition | `initTRPC` router types, primarily inferred from implementation |
| Streaming | Typed `stream:true` RPC; WebSocket proven | `eventIterator` output; `RPCHandler`/`RPCLink` WebSocket proven | Subscriptions over WebSocket/SSE; not benchmarked |
| Browser / Tauri | Browser bundle proven | Browser bundle proven | Supported; not built in this spike |
| Codegen for TS | None | None | None |
| OpenAPI from **same contract** | Not tested | **Proven**, OpenAPI 3.1.1 with typed JSON request and SSE event payload | Not tested in this spike; requires additional integration for OpenAPI |
| Loopback median first delta | 7.67 ms | 39.96 ms | Not measured |
| Loopback median completion (2,001 events) | 9.46 ms | 48.46 ms | Not measured |
| Browser entry (minified / gzip) | 265,547 / **87,020 B** | 308,049 / **64,816 B** | Not measured |
| Main tradeoff | More layers/scopes and protocol complexity; mirrors T3 internals | Simple contract/handler/client split; initial WS setup overhead in this test | Router-first ownership is less aligned with an independently authored contract |

API references: [oRPC v1 WebSocket RPC link](https://v1.orpc.dev/docs/client/rpc-link), [oRPC event iterators](https://v1.orpc.dev/docs/event-iterator), [oRPC OpenAPI](https://orpc.dev/docs/openapi/openapi-specification), and [tRPC v11 subscriptions](https://trpc.io/docs/server/subscriptions).

## Decision (proposed)

Choose **oRPC v1 contract-first** with Zod in `packages/contracts`, WebSocket `RPCHandler`/`RPCLink` for live subscriptions, and HTTP endpoints for interoperable request/response and SSE where exposed. Group extension methods under versioned namespaces. Keep T3 Effect RPC in the engine adapter.

**Connection setup explains most of the observed 5× completion ratio.** The oRPC median reached its first delta at 39.96 ms and finished at 48.46 ms: only **8.50 ms** elapsed after the first delta for 1,999 more deltas plus the terminal event. Effect took 7.67 ms to first delta and 9.46 ms overall: **1.79 ms** after first delta. The first-delta gap is 32.29 ms of the 39.00 ms completion gap (~83%). Therefore the headline ratio reflects predominantly **a newly opened connection per request**, which is unlike a long-lived App connection. The remaining delivery difference still exists in this synthetic benchmark; persistent-connection latency and throughput **have not been measured** and must be verified before calling the stacks equivalent.

The stronger architectural benefit is the **same contract producing OpenAPI**. `api-openapi.mjs` imports `contract` directly from the tested `api-contract-orpc.mjs` and generates a **3,607-byte OpenAPI 3.1.1** document using `@orpc/openapi` and the Zod 4 JSON Schema converter. It describes `POST /subscribe`, a required JSON integer `count ≥ 1`, and `text/event-stream` events whose message data includes `kind`, `seq` and `text`. Python/Go extensions and external clients can use a documented HTTP/SSE API when the Gateway implements it; **the generated OpenAPI does not itself document the custom WebSocket RPC framing or prove an HTTP server is running**. This supports Neo's agnostic boundary without duplicating the schema.

oRPC's client entry was ~22.2 kB smaller gzip in this isolated browser build; this is a bundle-entry comparison, not the guaranteed incremental production App size. Effect remains a fallback if measured persistent-connection throughput, cancellation or error behavior materially favors it.

## Consequences

- Put the Zod contract and client transport in shared packages; do not bundle Node server handlers in the browser.
- Generate and publish a versioned OpenAPI document for advertised HTTP/SSE endpoints. Keep WebSocket transport conventions, authentication and streaming/reconnect semantics documented separately.
- Define typed errors, scoped auth, tenant isolation, cancellation, backpressure, reconnect/resume, extension route lifecycle, version negotiation and compatibility tests before shipping.
- Benchmark **one established WebSocket with repeated subscriptions** and representative concurrent streams; avoid treating this repeated-handshake microbenchmark as production latency.
- Leave T3 untouched; its Effect RPC is an internal adapter concern.

## Evidence

Reproduce from `spikes/P0-5-adr-drafts` (PowerShell):

~~~powershell
$env:NMH_UPSTREAM_CACHE='C:\Users\Neo\Desktop\nmh-upstream-cache'
pnpm.cmd install --frozen-lockfile
node upstream-path.test.mjs
node api-benchmark.mjs
node api-openapi.mjs
~~~

Prior measured proof (Windows, Node v22.23.2, loopback 127.0.0.1, one warm-up + five trials, server and client new per trial):

~~~text
effect-ws PASS medianFirstDeltaMs=7.67 medianCompletionMs=9.46 bundleGzipBytes=87020
orpc-ws   PASS medianFirstDeltaMs=39.96 medianCompletionMs=48.46 bundleGzipBytes=64816
API_BENCHMARK PASS
~~~

Rerun on 2026-11-18: Effect first delta **10.44 ms**, completion **12.55 ms**; oRPC first delta **45.57 ms**, completion **57.60 ms**. Both gzipped entry sizes were unchanged.

Follow-up proof from the **unchanged streaming contract**:

~~~text
node api-openapi.mjs
ORPC_OPENAPI PASS version=3.1.1 paths=/subscribe bytes=3607

Document excerpt:
"openapi": "3.1.1"
"/subscribe": {"post": {
  "requestBody": {"required":true, "content":{"application/json":{"schema":{
    "properties":{"count":{"type":"integer","minimum":1}}}}}},
  "responses":{"200":{"content":{"text/event-stream":{"schema":{...}}}}}
}}
SSE message data properties: kind (delta|done), seq (number), text (string)
~~~

The emitted specification is saved only to ignored `.cache/neo-openapi.json`. With no Zod converter the generated schema was generic (2,244 B); the explicit `ZodToJsonSchemaConverter` is essential for usable non-TS documentation. The loopback benchmark logs benign Effect shutdown interruptions after validation; the 2,001 event assertions passed. No model, account or remote API was used.

Smallest next contract test: generated OpenAPI schema assertion plus browser WebSocket subscription validation, then real HTTP/SSE handler interoperability and persistent-socket auth, cancellation and reconnect.
