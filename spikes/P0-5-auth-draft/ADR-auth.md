# Architectural Decision Record (ADR): Neo Gateway Authentication, Tenancy & Engine Credential Projection

- **Status**: Proposed
- **Date**: 2026-11-17
- **Author**: Gemini (Spike P0-5 Helper)
- **Scope**: Core Gateway Architecture, Engine Integration Seams, Multi-Tenancy & Authorization

---

## Context and Problem Statement

Neo Meta Harness operates as a unified super-agent harness coordinating multiple heterogeneous upstream engines:
- **Hermes Agent** (`v0.23.2`) for autonomous tool execution, subagent delegation, skill learning, and cron/kanban operations;
- **T3 Code Engine** (`v0.1.9`) for headless orchestration, code editing, diffing, and terminal execution;
- **DeepSeek Harness (DSH)** (`0.2.2-rc.1`) for local desktop automation, browser control, and computer-use tools.

None of these downstream engines natively understand multi-tenant isolation, workspaces, team roles (`owner`, `admin`, `member`, `viewer`), or unified user identity:
- **Hermes Dashboard API** (`web_server.py:657`) uses a single global `X-Hermes-Session-Token` with all-or-nothing admin access.
- **Hermes Runtime API** (`api_server.py:756`) uses per-profile `API_SERVER_KEY` bearer tokens, but lacks tenant scoping or role-based access control.
- **T3 Code Engine** (`EnvironmentAuth.ts:182`) enforces 17 fine-grained RPC scopes (`AuthEnvironmentScope`), but has no concept of multi-user organizations or workspaces.
- **DeepSeek Harness** relies entirely on OS-level process boundaries and injected environment credentials (`DEEPSEEK_API_KEY`).

Furthermore, Neo Meta Harness must operate seamlessly across two distinct operational form factors:
1. **Single-User Local Desktop Mode (Tauri 2)**: Zero-friction setup, local offline-first SQLite database, no forced cloud logins, and automatic loopback session bootstrapping.
2. **Multi-User / Team Mode (Self-Hosted VPS & Cloud)**: Multi-tenancy, workspace isolation, team invitations, role-based access control (`owner`, `admin`, `member`, `viewer`), scoped API tokens for CI/CD, and an evolutionary path to enterprise OIDC/SSO.

We must select and validate the authentication, authorization, and credential projection architecture for Neo Gateway.

---

## Decision Drivers

1. **Local Desktop Zero-Setup vs VPS Multi-Tenancy**: The solution must support instant offline local execution (no setup wizard or mandatory cloud connection) while scaling to team deployments without re-architecting the database or API surface.
2. **Team RBAC & Workspace Isolation**: Native support for organizations/workspaces with roles (`owner`, `admin`, `member`, `viewer`) where `viewer` role cannot mutate workspace resources (returns `403 Forbidden`).
3. **Revocable Scoped API Tokens**: Ability to mint personal access tokens (PATs) or CI/CD robot credentials scoped to specific workspaces, with instant revocation (`401 Unauthorized`).
4. **Database Alignment (Kysely + SQLite)**: Conformance with ADR 0003 (Kysely query builder) over Node 22 native `node:sqlite` or `better-sqlite3`.
5. **Engine Credential Projection**: Clean architectural boundary where Neo Gateway mints, securely stores, and projects ephemeral or scoped credentials to downstream engines (Hermes, T3, DSH) without exposing raw engine control planes to clients.
6. **Future-Proofing for OIDC & Passkeys**: Standardized architecture allowing drop-in upgrades to Passkeys (WebAuthn) and OIDC/SSO (Okta, GitHub, Google Workspace) in Phase 1 and Phase 2.

---

## Evaluated Options

### Option 1: Better Auth (v1.7.25) with Kysely Adapter and Plugins
A modern TypeScript-first authentication framework designed for multi-tenant, modular authentication:
- **Architecture**: Core library with modular plugins (`organization`, `bearer`, `admin`, `two-factor`, `passkey`).
- **Database**: Native adapter ecosystem supporting Kysely (`@better-auth/kysely-adapter@1.7.25`), Drizzle, and Prisma over SQLite and PostgreSQL.
- **Team RBAC**: The `organization()` plugin provides workspace/team hierarchies, invitations, and customizable access control rules (`hasPermission`).
- **Token Management**: The `bearer()` plugin enables Bearer header authentication (`Authorization: Bearer <token>`). Scoped API tokens and personal access tokens (PATs) can be issued as persistent sessions or dedicated tokens and instantly revoked.
- **Desktop Zero-Setup**: In desktop mode (`NEO_MODE=desktop`), an auto-bootstrap routine initializes an admin user and default workspace on first run, returning a persistent loopback token.

### Option 2: Hand-Rolled Minimal Core (`node:sqlite` + `crypto.scryptSync`)
A lightweight, zero-dependency session and RBAC implementation directly in Node 22:
- **Architecture**: Minimal custom tables (`users`, `sessions`, `workspaces`, `workspace_members`, `api_tokens`).
- **Security**: Built using Node standard libraries (`node:crypto` for scrypt password hashing, timing-safe equality checks, and SHA-256 session token hashing).
- **Control**: 100% bespoke code (~200 lines), zero external npm dependencies, direct SQL execution.
- **Tradeoffs**: Entire maintenance burden (session rotation, rate limiting, brute force protection, CSRF, cookie handling, passkeys, WebAuthn) falls entirely on the Neo core team.

### Option 3: OIDC-Centric Stack (`openid-client`) + External IdP
Delegate all authentication to an external OpenID Connect identity provider (Keycloak, Authentik, Dex, or Auth0):
- **Architecture**: Neo Gateway acts purely as an OIDC Relying Party (RP).
- **Tradeoffs**: Catastrophic for single-user local desktop mode; requires running a heavy external Docker container or mandatory cloud connection just to use the desktop application locally.

---

## Comparison Matrix

| Evaluation Dimension | Option 1: Better Auth (v1.7.25 + Kysely) | Option 2: Hand-Rolled Minimal Core | Option 3: OIDC Stack (`openid-client`) |
|---|---|---|---|
| **Local Account Management** | Out of the box (email/password with scrypt/argon2, verification flows). | Implemented manually via `node:crypto.scryptSync`. | Delegated to external identity provider. |
| **Passkey (WebAuthn) Ready** | Supported via official `@better-auth/passkey` plugin. | Requires implementing FIDO2/WebAuthn challenge-response and attestation validation. | Supported if external IdP supports WebAuthn. |
| **Team Roles & Tenancy** | Built-in via `organization()` plugin (`owner`, `admin`, `member`, custom roles). | Implemented via custom SQL joins and role check middleware. | Delegated via OIDC claims or external SCIM directory. |
| **Revocable API Tokens** | Supported via `bearer()` plugin and persistent session tokens; revoked via `auth.api.revokeSession`. | Implemented via `api_tokens` table with SHA-256 hashed tokens. | Requires OAuth2 token introspection endpoint (RFC 7662). |
| **OIDC / SSO Upgrade Path** | Drop-in `genericOAuth` / `oidcProvider` plugins without altering core schema. | Requires writing custom OIDC authorization code flow, PKCE, and JWKS verification. | Native; already built on OIDC. |
| **Desktop Zero-Setup** | Supported via auto-bootstrap bootstrap script on first boot. | Trivial; direct loopback session insert. | Poor; requires mock local IdP or internet connectivity. |
| **Database Portability** | Native Kysely adapter (`@better-auth/kysely-adapter`). | Native to whatever raw SQL or query builder is used. | Decoupled from application database. |
| **Maintenance Burden** | Maintained by active open-source community; continuous security patches. | 100% internal maintenance burden on the Neo team. | Medium (glue code and IdP orchestration). |

---

## Decision

Adopt **Better Auth (pinned to `v1.7.25`)** with the **Kysely Adapter (`@better-auth/kysely-adapter@1.7.25`)**, **`organization()`**, and **`bearer()`** plugins for Neo Gateway multi-tenant authentication and authorization, paired with:
1. A **15-line Kysely Dialect Driver Bridge** for Node 22 native `node:sqlite` (`stmt.columns().length > 0`).
2. An **Auto-Bootstrap Loopback Routine** for single-user desktop zero-setup.
3. The **Hand-Rolled Minimal Core (`auth-proof.mjs`)** preserved as an architectural reference and zero-dependency baseline.

### Detailed Technical Findings & Implementation Notes

During spike verification against Node 22 native `node:sqlite` (`DatabaseSync`), several critical architectural details were proven:

1. **Kysely `SqliteDialect` with Node 22 `node:sqlite`**:
   - Kysely's `SqliteDialect` was originally designed for `better-sqlite3`, where prepared statements expose a `.reader` getter (`true` if the statement yields rows).
   - In Node 22 native `node:sqlite`, `StatementSync` does not expose `.reader`.
   - Naive checks such as `query.trimStart().toLowerCase().startsWith('select')` fail because Better Auth uses CTE queries (`with "table_list" as ...`), `pragma table_info(...)`, and SQLite 3.35+ `RETURNING *` clauses (`insert into "user" ... returning *`).
   - If `reader` is false, Kysely dispatches the statement to `stmt.run()` instead of `stmt.all()`, discarding returned rows. This triggers `SchemaMismatchError` during migration checks and `FAILED_TO_CREATE_USER` during signup.
   - **Resolution**: Setting `reader: stmt.columns().length > 0` resolves this completely. In `node:sqlite`, `stmt.columns()` returns column definitions if and only if the statement yields rows.

2. **Better Auth Plugin Availability**:
   - In `better-auth@1.7.25`, there is no standalone plugin named `apiKey` in `better-auth/plugins`.
   - API tokens / Personal Access Tokens (PATs) are issued as persistent, scoped bearer tokens or custom session tokens, and authenticated via the official `bearer()` plugin (`headers: { authorization: 'Bearer <token>' }`).
   - Revocation is handled cleanly via `auth.api.revokeSession({ body: { token } })`.

3. **Organization Custom Roles & Permissions**:
   - When supplying custom roles to `organization({ roles: { ... } })`, Better Auth overwrites default roles unless explicitly merged: `{ ...defaultRoles, viewer: viewerRole }`.
   - Defining `viewerRole = defaultAc.newRole({ organization: [], member: [], invitation: [], team: [], ac: ['read'] })` guarantees that mutations (`organization: ['update', 'delete']`) are denied.
   - The `auth.api.hasPermission` API expects `body: { permissions: { resource: [action] } }` (plural `permissions`).

---

## Engine Credential Map

Neo Gateway acts as the central credential custodian and security perimeter. Downstream engines (Hermes, T3, DSH) have no concept of workspaces or team RBAC. Below is the operational map detailing credential projection:

| Engine Surface | Pinned Upstream Ref & Source File | Credential Type & Wire Transport | Minting Mechanism | Vault Storage & Rotation | Upstream Engine Enforcement | Neo Gateway Responsibility |
|---|---|---|---|---|---|---|
| **Hermes Dashboard API** | `hermes-agent@v0.23.2`<br>• `hermes_cli/web_server.py:657`<br>• `hermes_cli/web_server_session_token.py:42` | Bearer Token / Header:<br>`X-Hermes-Session-Token` or `Authorization: Bearer <token>` | Generated by Neo Gateway via `crypto.randomBytes(32).toString('hex')` and exported as `HERMES_DASHBOARD_SESSION_TOKEN`. | Stored in Neo Vault under `engines.hermes.dashboard_token`. Rotated on gateway restart or profile recreation. | **Binary All-or-Nothing Auth**: Validates token using `hmac.compare_digest`. Rejects invalid/empty tokens with `401 Unauthorized`. **No internal RBAC, no member scoping**. | **Full Multi-Tenant & RBAC Enforcement**: Must verify that the calling user has `owner`, `admin`, or `member` permissions before forwarding requests to `/api/profiles`, `/api/cron/*`, or `/api/plugins/kanban/*`. Denies `viewer` write mutations. |
| **Hermes Runtime API (aiohttp)** | `hermes-agent@v0.23.2`<br>• `gateway/platforms/api_server.py:756`<br>• `gateway/config.py:112` | Bearer Key:<br>`Authorization: Bearer <API_SERVER_KEY>` (min 16 chars) | Minted per bot profile by Neo Vault: `crypto.randomBytes(24).toString('hex')`. Injected via profile `.env` or `config.yaml`. | Stored in Neo Vault under `engines.hermes.profiles.<profile_id>.api_key`. Rotated on profile secret refresh. | **Profile-Level Isolation**: Authenticates `/v1/runs`, `/v1/chat/completions`, and profile prefix `/p/<profile>/*`. Rejects unauthorized keys with `401`. | **Tenant-to-Profile Routing**: Maps workspace resources to permitted bot profiles. Enforces user turn limits, tool approval policies (`HERMES_EXEC_ASK=1`), and denies untrusted inbound channel access. |
| **T3 Code Engine** | `t3code@v0.1.9`<br>• `apps/server/src/auth/EnvironmentAuth.ts:182`<br>• `apps/server/src/auth/http.ts:94`<br>• `packages/contracts/src/auth.ts:32` | Scoped Bearer Token / WebSocket Ticket:<br>`Authorization: Bearer <token>` for ticket exchange, then `wsTicket` parameter on `/ws?orchestrationProtocol=2` | Minted via T3 CLI: `t3 auth session issue --scope <scopes> --ttl <ttl> --token-only` or programmatic `EnvironmentAuth.issueSession`. | Stored in Neo Vault under `engines.t3.sessions.<session_id>`. Short-lived (e.g. 15m–1h TTL), auto-refreshed before expiry. | **Granular RPC Scope Enforcement**: Enforces 17 discrete scopes (`orchestration:read`, `orchestration:operate`, `settings:write`, `providers:manage`, etc.) via `RpcScopeAuthorization` middleware. | **Role-to-Scope Mapping**: Neo maps user roles to minimal T3 scopes. `viewer` receives only `orchestration:read`; `member` receives `orchestration:operate`; `admin`/`owner` receives `providers:manage` and `settings:write`. |
| **DeepSeek Harness (DSH)** | `deepseek-harness@0.2.2-rc.1`<br>• `dsh-superagent@8c32a9dc5d72`<br>• Process boundary (`stdio` IPC) | Process Isolation & Environment Variables:<br>`DEEPSEEK_API_KEY`, `DSH_CONFIG_PATH` passed over process spawn | Injected into spawned child process environment block directly from Neo Vault. | Provider keys stored encrypted in Neo Vault. No long-lived network socket or shared daemon state. | **Process Boundary Only**: DSH inherits provided stdio handles and environment variables. Relies entirely on parent process isolation. | **Process Sandboxing & Resource Limits**: Sanitizes environment variables, scrubs sensitive host tokens, enforces process timeouts, CPU/memory ceilings, and terminates subprocesses upon session completion. |

---

## Consequences

### Positive
- **Standardized, Hardened Auth Stack**: Using Better Auth eliminates custom cryptography, session fixation vulnerabilities, and hand-rolled password hashing logic.
- **Full Tenancy & RBAC Coverage**: Native support for organizations, member roles (`owner`, `admin`, `member`, `viewer`), and permissions.
- **Seamless Engine Shielding**: All downstream engines are fully shielded behind Gateway authentication and role checks.
- **Zero-Setup Desktop Compatibility**: Local desktop single-user workflow remains friction-free via auto-bootstrap loopback sessions.

### Negative & Operational Tradeoffs
- **Kysely Node:SQLite Shim Requirement**: Requires maintaining the ~15-line `reader: stmt.columns().length > 0` adapter bridge when running on Node 22 native `node:sqlite`.
- **Framework Overhead**: Better Auth generates multiple tables (`user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`), which is heavier than a bespoke 3-table schema, but warranted by team/multi-tenant requirements.

---

## Evidence

The architecture is proven by two runnable test suites in `spikes/P0-5-auth-draft`:
1. `auth-proof-better-auth.mjs`: Real Better Auth implementation with Kysely on Node 22 `node:sqlite` passing all 10 checks.
2. `auth-proof.mjs`: Hand-rolled baseline reference implementation passing all 10 checks.
See `spikes/P0-5-auth-draft/README.md` for full test execution logs.
