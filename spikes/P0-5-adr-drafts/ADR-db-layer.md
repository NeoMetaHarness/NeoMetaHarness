# P0-5 ADR draft — Gateway database layer

Status: **PROPOSED; both SQL dialects exercised**. PM review required. Date: 2026-11-18.

## Context

The Neo Gateway uses local SQLite by default and PostgreSQL for teams. Services and extensions require one database interface and as much shared query/migration logic as is sound, while preserving vendor-specific escape hatches (FTS5/pgvector, JSON/date types, conflict behavior, concurrency).

Compare Drizzle ORM 0.44.7 and Kysely 0.28.8 without Docker, a preinstalled PostgreSQL service, user data or administrative installation.

## Options

| Criterion | Drizzle 0.44.7 | Kysely 0.28.8 |
| --- | --- | --- |
| SQLite and PostgreSQL | Supported, verified on both | Supported, verified on both |
| Logical schema source | **Two dialect-specific declarations**: `sqliteTable` and `pgTable`; their column builders/types differ. Can share business-level definitions/factories, but not one identical table object | One `Database` TS interface drives query types against either dialect; same query and common-subset schema builder |
| Migration approach | Drizzle Kit generation **per dialect** or explicit SQL scripts; not cross-dialect single generated migration | `Migrator` and common schema builder; divergent SQL still needs branches and distinct revisions as appropriate |
| SQLite proof | `sqlite-proxy` + in-memory `node:sqlite`, migration + query twice | `SqliteDialect`, **identical shared** helper twice |
| PostgreSQL proof | `drizzle-orm/pglite` + `pgTable`, migration + query twice | `PGliteDialect` with PostgreSQL WASM, **same shared** helper twice; also proven with native PostgreSQL 18.6 via `PostgresDialect` |
| Relative benefit | Strong declarative database schemas and generated migrations | Truly shared service query code and portable schema-builder migration for the common SQL subset |
| Main risk | Duplicate dialect declarations and distinct migration outputs | TS interface/migration drift; custom SQL paths must be tested per dialect |

PGlite is a real PostgreSQL engine compiled to WebAssembly and is suitable evidence for PostgreSQL SQL semantics. It is **not a proxy for team connection pooling, network/auth behavior or production concurrency**. For stronger evidence, a local disposable native PostgreSQL 18.6 server was also executed successfully.

## Decision (proposed)

Select **Kysely** behind Neo-owned `DatabaseProvider` and repository interfaces. The provider picks `SqliteDialect` locally or `PostgresDialect` with `pg` for teams; business code uses one `Kysely<Database>` interface for the common subset. The ~12-line `db-portable-kysely.mjs` does the **same CREATE TABLE → INSERT → SELECT/assert** on each dialect without dialect-specific branching. Two fresh in-memory SQLite databases and two fresh PGlite PostgreSQL databases passed this exact function. The same helper also passed against a disposable **native PostgreSQL 18.6** process on port 5544.

Drizzle is viable and also passed migration/query twice on SQLite and twice on PGlite. It requires **`sqliteTable` and `pgTable` as distinct schema declarations** and typically dialect-specific migration generation. We prefer Kysely here because Neo's most important contract is shared repository/query behavior under interchangeable backends.

## Consequences

- Keep Kysely's TS `Database` type synchronized with versioned migrations; require type checks and upgrades-from-prior-version integration tests.
- Branch intentionally for SQLite FTS5 vs PostgreSQL search/pgvector, conflict clauses and other nonportable SQL; keep database-specific migration variants where needed.
- `node:sqlite` is an experimental Node 22 driver; this spike does not choose a production SQLite connector.
- `kysely-pglite-dialect@1.4.0` is deprecated in favor of newer Kysely built-in PGlite support. Pinned Kysely 0.28.8 here does not export it; this dependency is **test-only** and the team adapter should use `PostgresDialect`.
- Evaluate transaction isolation, concurrent writes, connection pools, tenant isolation, backup/restore, extension migrations and upgrade paths before production.

## Evidence

All commands in `spikes/P0-5-adr-drafts`; Windows, Node v22.23.2:

~~~powershell
$env:NMH_UPSTREAM_CACHE='C:\Users\Neo\Desktop\nmh-upstream-cache'
pnpm.cmd install --frozen-lockfile
node db-proof.mjs
node db-pglite-proof.mjs
node db-embedded-postgres-proof.mjs
~~~

Trimmed observed output:

~~~text
DRIZZLE_SQLITE PASS trial=1 sqliteTable declaration
KYSELY_SQLITE PASS trial=1 shared=db-portable-kysely.mjs
DRIZZLE_SQLITE PASS trial=2 sqliteTable declaration
KYSELY_SQLITE PASS trial=2 shared=db-portable-kysely.mjs
DB_SQLITE_PROOF PASS trials=2

KYSELY_PGLITE PASS trial=1 shared=db-portable-kysely.mjs
DRIZZLE_PGLITE PASS trial=1 pgTable declaration
KYSELY_PGLITE PASS trial=2 shared=db-portable-kysely.mjs
DRIZZLE_PGLITE PASS trial=2 pgTable declaration
DB_PGLITE_PROOF PASS trials=2

KYSELY_NATIVE_POSTGRES PASS version=18.6 port=5544
DB_EMBEDDED_POSTGRES_CLEANUP PASS temp=deleted
~~~

`db-embedded-postgres-proof.mjs` installs pinned `embedded-postgres@18.6.0-beta.19` locally (including a Windows x64 binary), initializes a unique temp-dir cluster, listens only on loopback port **5544**, invokes the exact shared Kysely function through the native `pg` pool, stops PostgreSQL and deletes the generated temp directory. It uses an invented throwaway login and makes no writes to user databases. `autoRehydrateSymlinks:true` allows local installation without admin and with the native-platform postinstall script explicitly denied. The native probe exercises only the Kysely path; Drizzle's PostgreSQL semantics are independently exercised through PGlite twice.

The earlier guarded `db-pg-proof.mjs` remains available for an explicitly isolated external PostgreSQL server, but is not needed to prove the two SQL dialects locally. Production migrations, transaction semantics and load are still untested.

Smallest next acceptance test: run versioned migration upgrades plus the same typed repository contract against the selected production SQLite driver and pooled PostgreSQL under concurrent transactions, including rollback and dialect-specific search paths.
