# Architecture Decision Records

| # | Decision | Status |
|---|---|---|
| [0001](0001-desktop-shell.md) | Desktop shell: Tauri 2 (system webview) instead of Electron | Accepted 2026-11-17 |
| [0002](0002-api-style.md) | Neo API: oRPC contract-first (Zod), WS streams + HTTP, OpenAPI for non-TS clients | Accepted 2026-11-18 |
| [0003](0003-db-layer.md) | Gateway DB: Kysely behind a Neo `DatabaseProvider` (SQLite default, Postgres for teams) | Accepted 2026-11-18 |
| [0004](0004-kernel.md) | Gateway kernel: Cordis (DSH's pinned build) behind `@neometaharness/kernel` | Accepted 2026-11-18 |
| [0005](0005-auth.md) | Auth and teams: Better Auth 1.7.25 on Kysely (organization, bearer, api-key); Neo enforces engine access | Accepted 2026-11-18 |
