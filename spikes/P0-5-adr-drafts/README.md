# P0-5 — Neo API style + dual-dialect DB architecture (ADR drafts)

**Verdict: WORKS WITH WORKAROUND** for WebSocket contract proofs and SQLite; **PostgreSQL BLOCKED** pending a disposable Docker database. These are **proposals for PM review**, not product changes or accepted decisions.

**Question:** Which RPC technology offers a schema-first, codegen-free, stream-capable Gateway ↔ App contract for browser/Tauri/remote clients? Which DB library best supports one interface with SQLite by default and PostgreSQL for teams?

**Pinned ref:** `t3code@v0.1.9` (via root `upstream.lock.json`); package versions fixed in this directory's `package.json` / `pnpm-lock.yaml`: Effect RPC/Effect 4.1.2, oRPC 1.16.2, tRPC server 11.28.3, Drizzle 0.44.7, Kysely 0.28.8.

**Seam:** Pinned T3 `packages/contracts/src/rpc.ts` and `apps/server/src/ws.ts` for Effect RPC; local `api-contract-effect.mjs` / `api-contract-orpc.mjs` with corresponding client/server proofs. DB seams: `drizzle-orm/sqlite-proxy`, `drizzle-orm/node-postgres`, `kysely/SqliteDialect` and `kysely/PostgresDialect`.

## Deliverables

- [ADR-api-style.md](ADR-api-style.md) — **propose oRPC v1 contract-first** for Neo Gateway ↔ App; evaluate Effect RPC and tRPC v11, include measurements and limitations.
- [ADR-db-layer.md](ADR-db-layer.md) — **provisionally propose Kysely** for SQLite/PostgreSQL, conditional on disposable PostgreSQL execution.
- [upstream-path.mjs](upstream-path.mjs) — reads repository `upstream.lock.json`, resolves `<name>@<ref>` from `NMH_UPSTREAM_CACHE` or default `../nmh-upstream-cache` from repo root, rejects unpinned refs and traversal. Used by the benchmark and both database proofs.
- [api-benchmark.mjs](api-benchmark.mjs) — identical 2,000-delta ordered stream for Effect and oRPC, one warm-up plus five trials, first-delta and full-completion latency, minified browser ESM bundle bytes + gzip.
- [db-portable-kysely.mjs](db-portable-kysely.mjs) — ~12-line shared migration/query function, invoked by both dialect harnesses; SQLite execution proven.
- [db-proof.mjs](db-proof.mjs) and [db-pg-proof.mjs](db-pg-proof.mjs) — Drizzle/Kysely migration + insert/select on SQLite; guarded schema-isolated PostgreSQL counterpart, not executable here.

## Reproduce (PowerShell; within this directory)

~~~powershell
$env:NMH_UPSTREAM_CACHE='C:\Users\Neo\Desktop\nmh-upstream-cache'
pnpm.cmd install --frozen-lockfile   # only if node_modules is absent
node upstream-path.mjs t3code
node upstream-path.test.mjs
node api-benchmark.mjs
node db-proof.mjs
node --check db-pg-proof.mjs
node db-pg-proof.mjs
~~~

`NMH_UPSTREAM_CACHE` is needed on this machine because the **shared** cache is at `C:\Users\Neo\Desktop\nmh-upstream-cache`, while the resolver's requested default is relative to the repository root. No files were written to the upstream cache. The docs in this directory intentionally carry no credentials or tokens.

## Evidence (2026-11-17; trimmed actual output)

~~~text
node upstream-path.mjs t3code
{"name":"t3code","ref":"v0.1.9","resolved":"C:\\Users\\Neo\\Desktop\\nmh-upstream-cache\\t3code@v0.1.9","exists":true,...}

node upstream-path.test.mjs
UPSTREAM_RESOLVER PASS t3code@v0.1.9 pinned; env/default path and traversal checked

node api-benchmark.mjs
effect-ws PASS runsMs=[21.23,9.54,9.06,9.46,8.76]
  medianCompletionMs=9.46 medianFirstDeltaMs=7.67
  bundleBytes=265547 bundleGzipBytes=87020
orpc-ws PASS runsMs=[81.45,51.26,48.46,47.55,47.08]
  medianCompletionMs=48.46 medianFirstDeltaMs=39.96
  bundleBytes=308049 bundleGzipBytes=64816
baselineBytes=42 node=v22.23.2 deltas=2000 trials=5 warmup=1
API_BENCHMARK PASS

node db-proof.mjs
DRIZZLE_SQLITE PASS migration=drizzle.run(raw SQL), insert/select, node:sqlite proxy
KYSELY_SQLITE PASS migration=schema builder, insert/select, node:sqlite
DB_SQLITE_PROOF PASS

node db-pg-proof.mjs
DB_POSTGRES BLOCKED (requires disposable local Docker PostgreSQL ...)
docker --version -> command not recognized
podman --version -> command not recognized
~~~

Effect RPC's underlying HTTP/WebSocket layer writes informational `InterruptError / status 503` log entries during the **expected teardown** of the scoped WS server; they appear after validated ordered delivery. The numbers measure synthetic localhost completion, not typical remote latency; they are not promises for the product. The browser build compiles without external Node `ws` imports. The SQLite node:sqlite driver emits an experimental warning on Node 22.

**Risks:** PG remains untested; gateway authentication, authorization, cancellation, backpressure, reconnection and concurrency untested. oRPC v1 API may change on major upgrades. DB cross-dialect DDL and migrations need a production-level test matrix. SQLite adapter is throwaway glue; no default production driver is prescribed here.

**Architecture impact:** Propose `oRPC` for `docs/02-architecture.md` section 4 and `Kysely` for the Gateway DB. PM owns docs changes. Wrap T3 Effect RPC inside `engine-t3`; expose Neo contracts independently. Require PostgreSQL proof before accepting the DB decision.

**Contract test idea:** Spawn a Gateway with fake auth and two subscribers, verify the same 2,001 ordered frames, invalid-input rejection, cancellation/reconnect, extension unmount and namespace auth. Separately, run one versioned migration and shared Kysely repository test on disposable SQLite and PostgreSQL twice, ensuring PostgreSQL schema cleanup.

No real LLM, account, user credential, global DSH home, GitHub write, push or product-code edit was involved.
