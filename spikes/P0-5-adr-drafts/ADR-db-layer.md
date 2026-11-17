# P0-5 ADR draft — Gateway database layer

Status: **PROPOSED, conditional on PostgreSQL verification**; PM review required. Date: 2026-11-17.

## Context

The Gateway defaults to a local SQLite database for individuals and uses PostgreSQL for teams. Services, extensions and the App must not depend on a specific SQL driver. We want one repository interface and mostly shared query/migration logic, no required database code generation, and explicit dialect handling for features that differ (FTS5 vs pgvector, conflict behavior, JSON/date types, concurrency).

The question is whether Drizzle ORM 0.44.7 or Kysely 0.28.8 minimizes maintenance for these two runtime choices.

## Options

| Criterion | Drizzle 0.44.7 | Kysely 0.28.8 |
| --- | --- | --- |
| SQLite + PostgreSQL | Both supported | Both built-in dialects supported |
| Model/source of truth | Typed TS table declarations drive queries; `drizzle-kit` can generate migration SQL | Typed `Database` interface drives queries; hand-authored migrations (schema builder or SQL), no built-in generator |
| Common table definition | Separate dialect-specific `sqliteTable` and `pgTable` objects; core types differ | One logical `Database` TS interface and one common query builder against either dialect |
| Migrations | Dialect-specific Drizzle Kit config/output, or explicit SQL scripts | Same `Migrator` interface and schema builder for common subset; dialect branches for vendor specifics |
| Runtime adapters proven here | SQLite through `sqlite-proxy` + Node `DatabaseSync` | SQLite through `SqliteDialect` + thin `DatabaseSync` adapter |
| PostgreSQL proof | Script prepared with `pgSchema` and schema-qualified queries; **blocked/unexecuted** | Script prepared with `PostgresDialect` + `pg` and isolated schema; **blocked/unexecuted** |
| Ergonomics tradeoff | Great schema-first types + generated migrations | Uniform SQL-like query API; manually maintain schema/type agreement |

See [Drizzle schema declaration](https://orm.drizzle.team/docs/sql-schema-declaration), [Drizzle migrations](https://orm.drizzle.team/docs/migrations), and [Kysely dialects](https://kysely.dev/docs/getting-started?dialect=sqlite). These are general documentation references; local proof results are below.

## Decision (proposed)

Select **Kysely** as the Gateway's query/migration layer, hidden behind a Neo-owned `DatabaseProvider` and repositories. A provider chooses `SqliteDialect` (local) or `PostgresDialect` (team); application logic uses one `Kysely<Database>` shape and query helper where SQL features overlap. Explicitly branch per dialect for FTS5/pgvector, connection setup, conflict behavior and nonportable DDL.

The shared `db-portable-kysely.mjs` proof contains **one ~12-line migration/insert/select body** accepting either Kysely dialect; the SQLite wrapper executes it, and the PostgreSQL wrapper invokes the identical body with a schema qualifier. This is stronger architectural evidence for the common-interface requirement than two unrelated snippets, but only the SQLite invocation was executed.

Provisional status matters: **the PostgreSQL half remains BLOCKED** because no Docker/Podman/installed PostgreSQL executable was available. Do not record this ADR as accepted until an isolated PostgreSQL run passes. Drizzle is a viable alternative if generated migrations and schema-as-code prove more important than a shared query surface.

## Consequences

- Define a small, strongly typed `Database` schema and service-level repositories in Gateway code; extensions receive repository/capability interfaces, not raw pools. Kysely types must be kept synchronized with migrations; require type checks and integration tests for migration drift.
- Store monotonically versioned, transactional migrations per supported dialect. Reuse Kysely schema-builder operations for portable DDL, but branch when SQL semantics diverge. Validate fresh install and migrations from the previous release on each database.
- SQLite production driver/connection choice is still open: the temporary `node:sqlite` adapter only proves an API seam. Node v22 logs an experimental warning. Prefer a supported stable driver or verify Node's native adapter against the shipping Node version.
- Team PostgreSQL connection pooling, tenant security, concurrent writes, backup/restore, FTS extensions and performance were not tested. Neither ORM was used with a live production database.

## Evidence

PowerShell in `spikes/P0-5-adr-drafts`:

~~~powershell
$env:NMH_UPSTREAM_CACHE='C:\Users\Neo\Desktop\nmh-upstream-cache'
node upstream-path.test.mjs
node db-proof.mjs
node --check db-pg-proof.mjs
node db-pg-proof.mjs
docker --version
podman --version
~~~

Observed:

~~~text
UPSTREAM_RESOLVER PASS t3code@v0.1.9 pinned; env/default path and traversal checked
DRIZZLE_SQLITE PASS migration=drizzle.run(raw SQL), insert/select, node:sqlite proxy
KYSELY_SQLITE PASS migration=schema builder, insert/select, node:sqlite
DB_SQLITE_PROOF PASS
ExperimentalWarning: SQLite is an experimental feature...
DB_POSTGRES BLOCKED (requires disposable local Docker PostgreSQL ...)
docker: command not recognized
podman: command not recognized
~~~

PostgreSQL proof source is **ready to inspect, not proven to run**. It demands `NMH_PG_ISOLATED=1` and `NMH_PG_TEST_URL`, requires a loopback URL, creates randomly named dedicated schemas, schema-qualifies all read/write DDL/DML, and drops only those generated schemas on cleanup. It does not modify connection-pool `search_path`. To execute later: launch a **disposable PostgreSQL Docker container** with a loopback port, set the two environment variables, run `node db-pg-proof.mjs`, and inspect successful data assertions and schema cleanup. Never point it at a user or production database.

Minimum next acceptance test: run both ORM paths on disposable PostgreSQL twice (including cleanup), then exercise the same migration version sequence and repository tests on SQLite and PostgreSQL using the intended production drivers.
