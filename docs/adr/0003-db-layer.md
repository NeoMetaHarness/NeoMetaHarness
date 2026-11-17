# ADR 0003 · Gateway database layer: Kysely behind a Neo DatabaseProvider

Status: **Accepted** · 2026-11-18 · Evidence: [P0-5 drafts](../../spikes/P0-5-adr-drafts/ADR-db-layer.md) (Codex; reproduced by the PM)

## Context
Single-user installs (desktop, PWA on a laptop) must work with zero setup: SQLite. Teams on a VPS need Postgres. Business code must not fork per dialect ([docs/02 §2](../02-architecture.md#2-layers): "SQLite by default / Postgres for teams").

## Options
| | **Kysely 0.28.8** | Drizzle 0.44.7 |
|---|---|---|
| One query/migration helper on both dialects | **yes**: the same `db-portable-kysely.mjs` passed on SQLite, PGlite and native Postgres 18.6 | no: needs separate `sqliteTable` and `pgTable` schema declarations, usually separate migrations |
| Type safety | typed query builder over a `Database` interface | typed schema-first ORM |
| Runtime weight | small, no codegen | small, plus drizzle-kit for migrations |

Measured: SQLite ×2, PGlite (Postgres in WASM) ×2 and native embedded Postgres 18.6 on port 5544. All passed, and the temporary server and folder were removed (`DB_EMBEDDED_POSTGRES_CLEANUP PASS`).

## Decision
Use **Kysely** behind a Neo-owned `DatabaseProvider` and repository interfaces in the Gateway. The provider picks `SqliteDialect` (default, a file in the Neo home) or `PostgresDialect` with `pg` (teams). Repositories and migrations are written once in portable Kysely. Dialect-only features (FTS5, pgvector) go behind small dialect-specific adapters, never in business code.

## Consequences
- Every migration runs in `neo check` on SQLite and on PGlite. Native Postgres runs in the P1 release check.
- PGlite proves SQL semantics, not pooling, network auth or production tuning. Those are covered by the team-mode test (P1).
- `kysely-pglite-dialect` is test-only (deprecated upstream). Production uses `pg`.
- Data in extensions: an extension gets its own table prefix and migrations through the provider, and its data survives disable ([docs/05](../05-extension-system.md)).
