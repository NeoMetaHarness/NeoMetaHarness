# P0-5 — Neo API style + dual-dialect DB architecture (ADR drafts)

**Verdict: WORKS** for the scoped OpenAPI, ordered WebSocket benchmark, SQLite, PGlite PostgreSQL and disposable native PostgreSQL proofs. Both decisions remain **PROPOSED for PM review**; no production code was changed.

**Question:** Which schema-first, codegen-free API supports streaming for browser/Tauri/remote clients and discovery by Python/Go extensions? Which database layer provides portable SQLite/PostgreSQL service queries?

**Pinned ref:** `t3code@v0.1.9` from `upstream.lock.json`, with dependency versions fixed in this folder's `package.json` and `pnpm-lock.yaml`: Effect RPC 4.1.2, oRPC 1.16.2, tRPC 11.28.3, Drizzle 0.44.7, Kysely 0.28.8, PGlite 0.5.16, embedded PostgreSQL 18.6.

**Seams:** T3 `packages/contracts/src/rpc.ts` and `apps/server/src/ws.ts`; oRPC `@orpc/contract` → `@orpc/openapi` + Zod schema converter; Kysely `SqliteDialect`, PGlite adapter and `PostgresDialect`; Drizzle `sqliteTable` versus `pgTable`.

## Deliverables

- [ADR-api-style.md](ADR-api-style.md): propose oRPC v1, with measured first-delta/connection overhead and **OpenAPI from the exact streaming contract**.
- [ADR-db-layer.md](ADR-db-layer.md): propose Kysely, with verified dual-dialect shared migration/query code and Drizzle's separate schema types.
- [api-contract-orpc.mjs](api-contract-orpc.mjs) and [api-openapi.mjs](api-openapi.mjs): unchanged ordered-stream contract and a ~10-line 3.1.1 OpenAPI generator.
- [api-benchmark.mjs](api-benchmark.mjs): Effect/oRPC 2,000-delta WebSocket loopback + minified/gzipped browser entry sizes.
- [db-portable-kysely.mjs](db-portable-kysely.mjs): same CREATE TABLE / INSERT / SELECT across all Kysely drivers.
- [db-proof.mjs](db-proof.mjs): fresh SQLite dialect and Drizzle tests **twice**.
- [db-pglite-proof.mjs](db-pglite-proof.mjs): fresh PGlite PostgreSQL dialect and Drizzle tests **twice**.
- [db-embedded-postgres-proof.mjs](db-embedded-postgres-proof.mjs): disposable native Postgres 18.6 loopback port 5544, guaranteed temp-dir cleanup.
- [upstream-path.mjs](upstream-path.mjs) / [upstream-path.test.mjs](upstream-path.test.mjs): pinned upstream cache resolver with `NMH_UPSTREAM_CACHE` override and traversal checks.
- [db-pg-proof.mjs](db-pg-proof.mjs): optional guarded external native PostgreSQL proof; not needed for this acceptance.

## Reproduce (PowerShell, from this directory)

~~~powershell
$env:NMH_UPSTREAM_CACHE='C:\Users\Neo\Desktop\nmh-upstream-cache'
pnpm.cmd install --frozen-lockfile
pnpm.cmd test
pnpm.cmd run probe:db:native
~~~

The executable scripts in `pnpm test` are the resolver check, OpenAPI generation, API benchmark, SQLite proof and PGlite proof. Native PostgreSQL is a separate run because it starts a platform-specific binary on port 5544; on Windows the `autoRehydrateSymlinks` option removes the need for a privileged install script. No Docker, administrator permission, real account or global install is needed. `NMH_UPSTREAM_CACHE` is required on this PC because its shared cache is in a nondefault location; nothing is modified there.

## Evidence (2026-11-18; trimmed observed output)

~~~text
node api-openapi.mjs
ORPC_OPENAPI PASS version=3.1.1 paths=/subscribe bytes=3607

node db-proof.mjs
DRIZZLE_SQLITE PASS trial=1 sqliteTable declaration
KYSELY_SQLITE PASS trial=1 shared=db-portable-kysely.mjs
DRIZZLE_SQLITE PASS trial=2 sqliteTable declaration
KYSELY_SQLITE PASS trial=2 shared=db-portable-kysely.mjs
DB_SQLITE_PROOF PASS trials=2

node db-pglite-proof.mjs
KYSELY_PGLITE PASS trial=1 shared=db-portable-kysely.mjs
DRIZZLE_PGLITE PASS trial=1 pgTable declaration
KYSELY_PGLITE PASS trial=2 shared=db-portable-kysely.mjs
DRIZZLE_PGLITE PASS trial=2 pgTable declaration
DB_PGLITE_PROOF PASS trials=2

node db-embedded-postgres-proof.mjs
KYSELY_NATIVE_POSTGRES PASS version=18.6 port=5544
DB_EMBEDDED_POSTGRES_CLEANUP PASS temp=deleted
~~~

Existing benchmark evidence reproduced by PM on 2026-11-17 (1 warmup, 5 trials, new socket per subscription): Effect first delta **7.67 ms**, completion **9.46 ms**, gzip **87,020 B**; oRPC first delta **39.96 ms**, completion **48.46 ms**, gzip **64,816 B**. oRPC delivered remaining events in **8.50 ms** after first delta; this isolates most difference to initial connection, while residual delivery differences and long-lived socket performance need more testing.

A second benchmark run on 2026-11-18 yielded Effect first delta/completion **10.44/12.55 ms** and oRPC **45.57/57.60 ms**; bundle gzip sizes were unchanged. The setup-heavy pattern persists.

**Risks:** oRPC generated OpenAPI documents HTTP JSON/SSE, not WS wire framing. Gateway auth, cancellation, reconnect, concurrency and browser lifecycle remain unproven. PGlite is Postgres SQL in WASM but not a network server; native Postgres here is single-process and disposable, not a team production setup. Drizzle needs dialect-specific declarations/migrations, while Kysely requires migrations aligned with its TS interface. `node:sqlite` on Node 22 emits an experimental warning. The spike-local `pnpm-workspace.yaml` narrowly allows esbuild's build and denies the embedded PostgreSQL Windows postinstall; native PG rehydrates its required links at runtime. The frozen install command above passed with these rules.

**Architecture impact:** Propose oRPC for Gateway ↔ App `packages/contracts` with OpenAPI HTTP/SSE output and a separate documented WebSocket transport; keep upstream T3 Effect RPC in `engine-t3`. Propose Kysely behind `DatabaseProvider` with SQLite default and pooled Postgres for teams. PM owns `docs/` edits; no product, root, machine or upstream file was changed.

**Contract test idea:** Generated OpenAPI request/SSE schema snapshots plus a real HTTP handler, one persistent WebSocket with concurrent ordered streams/auth/cancel/reconnect, and versioned database migrations across both production drivers and rollback.

No model subscription, personal sign-in, GitHub write, push, user database, or other worktree was used.
