# P0-5 ADR draft — Neo Auth, Teams, and Engine Credential Projection

Status: **PROPOSED**; PM review required. Date: 2026-11-18.

## Context

Neo Gateway sits between user interfaces (desktop app, Tauri webview, PWA, CLI) and underlying execution engines (Hermes Agent, T3 Code, DeepSeek Harness). As specified in `docs/02-architecture.md` §4 ("Auth and teams") and §14 ("Security"):
- **Workspace Hierarchy**: `Workspace` → `Members` → `Roles` (`owner`, `admin`, `member`, `viewer`) → `Scoped Resources` (bots, projects, computers, channels, skills).
- **Dual Deployment Modes**:
  1. *Single-user local desktop*: Zero-setup, instant friction-free bootstrap (auto-provisioned local workspace and admin session, loopback trust, optional local password/passkey).
  2. *VPS team mode*: Multi-tenant collaboration, member invitations, strict role-based access control (RBAC), and scoped bearer API tokens for remote CLI and background automations.
- **Identity Evolution**: Local accounts and passkeys in v1, with a clean upgrade path to external OIDC / Enterprise SSO (Google, GitHub, Okta) without schema rewrites.
- **Engine Credential Projection**: No external client or web UI talks directly to execution engines. The Gateway Vault securely holds engine credentials, projects them in each engine's expected wire format, and enforces tenant/workspace isolation that engines natively lack.

The architectural question is: which authentication and team authorization architecture best satisfies both the local desktop and VPS team requirements, and how are engine credentials securely minted, scoped, rotated, and mapped across T3, Hermes, and DSH?

---

## Options Comparison

| Criterion | Option 1: Better Auth (v1.2+) | Option 2: Hand-Rolled Minimal Core (Lucia-style) | Option 3: OIDC-Centric Stack (openid-client + custom) |
|---|---|---|---|
| **Local Accounts** | Built-in email/password with secure password hashing (scrypt/argon2), email verification hooks. | Custom implementation required (~150 LOC for password hashing, salts, rate-limiting). | External IdP focus; local account fallback requires building custom local credential provider. |
| **Passkeys (WebAuthn)** | First-class `@better-auth/passkey` plugin (SimpleWebAuthn integration). | Hand-roll WebAuthn registration/assertion ceremonies, challenge stores, and counter checks. | Dependent on external IdP WebAuthn support or custom plugin. |
| **Team Roles & Workspaces** | Built-in `organization` plugin with workspaces, invitations, dynamic membership, and predefined/custom roles (`owner`, `admin`, `member`, `viewer`). | Custom database tables (`workspaces`, `workspace_members`, `invitations`) and authorization middleware. | Organization concept mapped externally or custom-authored in application database. |
| **API Tokens (CLI/Remote)** | Built-in `bearer` / `apiKey` plugin with token hashing (SHA-256), prefixes, scopes, and expiration. | Custom token generator (`crypto.randomBytes`), database hash table, and bearer middleware. | Token issuance requires custom token service or OAuth2 Authorization Server extension. |
| **OIDC / SSO Upgrade Path** | Native `genericOAuth` / `oidcProvider` plugins; accounts link directly to existing local user records via `account` table. | Requires implementing OIDC authorization code flow, PKCE, token verification, and profile mapping. | Native and robust; built directly on standards-compliant OpenID Connect specifications. |
| **Desktop Zero-Setup** | Configurable auto-login / loopback bypass in desktop mode; can use SQLite in-memory or single-file storage. | Extremely lightweight; desktop mode can initialize a bypass session with zero external framework overhead. | Heavyweight for desktop; requires local mock IdP or local token endpoint. |
| **Database Portability** | Supports Kysely, Drizzle, and raw SQLite/PostgreSQL dialects out of the box. | Native to whatever query layer Neo chooses (Kysely/SQLite/Postgres). | Decoupled from database, but requires custom persistence adapters. |
| **Maintenance & Security** | Active community, comprehensive security tests, handles session fixation, CSRF, cookie prefixes, and rotation. | Full maintenance burden on the Neo team (session timing attacks, cookie flags, WebAuthn edge cases). | Core protocol is standards-compliant, but glue code and local auth must be maintained internally. |

---

## Decision (proposed)

Adopt **Better Auth** with the **Organization**, **Passkey**, and **API Key** plugins as the foundation for the Neo Gateway auth subsystem, paired with a **Desktop Auto-Bootstrap Middleware** for zero-setup single-user environments.

### Rationale
1. **Covers the full v1 and v2 scope out of the box**: Better Auth provides email/password, passkeys, multi-tenant workspace/organization hierarchies, member invitations, and revocable API tokens in a single modular TypeScript architecture.
2. **Schema and Database Alignment**: Better Auth natively generates and accepts Kysely and SQLite/PostgreSQL schemas, matching Neo's database layer decision (`spikes/P0-5-adr-drafts/ADR-db-layer.md`).
3. **Seamless OIDC Evolution**: Transitioning from v1 local accounts to v2 enterprise SSO requires adding the `oidcProvider` or OAuth plugins without altering the core `user`, `session`, `workspace`, or `role` tables.
4. **Desktop Zero-Setup Accommodation**: When running in `NEO_MODE=desktop`, the Gateway bypasses registration friction by auto-generating a local default workspace and loopback administrator session token during the first start.

---

## Engine Credential Map

Neo Gateway acts as the central credential custodian and security perimeter. Below is the exact operational map detailing how credentials for Hermes Agent, T3 Code, and DeepSeek Harness are minted, stored in the Neo Vault, rotated, and scoped, contrasting what upstream engines enforce against what Neo must enforce itself.

| Engine Surface | Pinned Upstream Ref & Source File | Credential Type & Wire Transport | Minting Mechanism | Vault Storage & Rotation | Upstream Engine Enforcement | Neo Gateway Responsibility |
|---|---|---|---|---|---|---|
| **Hermes Dashboard API** | `hermes-agent@v0.23.2`<br>• `hermes_cli/web_server.py:657`<br>• `hermes_cli/web_server_session_token.py:42` | Bearer Token / Header:<br>`X-Hermes-Session-Token` or `Authorization: Bearer <token>` | Generated by Neo Gateway via `crypto.randomBytes(32).toString('hex')` and exported as `HERMES_DASHBOARD_SESSION_TOKEN`. | Stored in Neo Vault under `engines.hermes.dashboard_token`. Rotated on gateway restart or profile recreation. | **Binary All-or-Nothing Auth**: Validates token using `hmac.compare_digest`. Rejects invalid/empty tokens with `401 Unauthorized`. **No internal RBAC, no member scoping**. | **Full Multi-Tenant & RBAC Enforcement**: Must verify that the calling user has `owner`, `admin`, or `member` permissions before forwarding requests to `/api/profiles`, `/api/cron/*`, or `/api/plugins/kanban/*`. Denies `viewer` write mutations. |
| **Hermes Runtime API (aiohttp)** | `hermes-agent@v0.23.2`<br>• `gateway/platforms/api_server.py:756`<br>• `gateway/config.py:112` | Bearer Key:<br>`Authorization: Bearer <API_SERVER_KEY>` (min 16 chars) | Minted per bot profile by Neo Vault: `crypto.randomBytes(24).toString('hex')`. Injected via profile `.env` or `config.yaml`. | Stored in Neo Vault under `engines.hermes.profiles.<profile_id>.api_key`. Rotated on profile secret refresh. | **Profile-Level Isolation**: Authenticates `/v1/runs`, `/v1/chat/completions`, and profile prefix `/p/<profile>/*`. Rejects unauthorized keys with `401`. | **Tenant-to-Profile Routing**: Maps workspace resources to permitted bot profiles. Enforces user turn limits, tool approval policies (`HERMES_EXEC_ASK=1`), and denies untrusted inbound channel access. |
| **T3 Code Engine** | `t3code@v0.1.9`<br>• `apps/server/src/auth/EnvironmentAuth.ts:182`<br>• `apps/server/src/auth/http.ts:94`<br>• `packages/contracts/src/auth.ts:32` | Scoped Bearer Token / WebSocket Ticket:<br>`Authorization: Bearer <token>` for ticket exchange, then `wsTicket` parameter on `/ws?orchestrationProtocol=2` | Minted via T3 CLI: `t3 auth session issue --scope <scopes> --ttl <ttl> --token-only` or programmatic `EnvironmentAuth.issueSession`. | Stored in Neo Vault under `engines.t3.sessions.<session_id>`. Short-lived (e.g. 15m–1h TTL), auto-refreshed before expiry. | **Granular RPC Scope Enforcement**: Enforces 17 discrete scopes (`orchestration:read`, `orchestration:operate`, `settings:write`, `providers:manage`, etc.) via `RpcScopeAuthorization` middleware. | **Role-to-Scope Mapping**: Neo maps user roles to minimal T3 scopes. `viewer` receives only `orchestration:read`; `member` receives `orchestration:operate`; `admin`/`owner` receives `providers:manage` and `settings:write`. |
| **DeepSeek Harness (DSH)** | `deepseek-harness@0.2.2-rc.1`<br>• `dsh-superagent@8c32a9dc5d72`<br>• Process boundary (`stdio` IPC) | Process Isolation & Environment Variables:<br>`DEEPSEEK_API_KEY`, `DSH_CONFIG_PATH` passed over process spawn | Injected into spawned child process environment block directly from Neo Vault. | Provider keys stored encrypted in Neo Vault. No long-lived network socket or shared daemon state. | **Process Boundary Only**: DSH inherits provided stdio handles and environment variables. Relies entirely on parent process isolation. | **Process Sandboxing & Resource Limits**: Sanitizes environment variables, scrubs sensitive host tokens, enforces process timeouts, CPU/memory ceilings, and terminates subprocesses upon session completion. |

---

## Consequences

### Positive
- **Unified Security Model**: Web clients, desktop wrappers, mobile apps, and remote CLIs authenticate against one standardized Gateway surface with role-aware permissions.
- **Zero-Trust Engine Isolation**: Downstream engines (Hermes, T3, DSH) never directly face the network or untrusted users; all RBAC and tenancy checks happen upstream in Neo.
- **Auditable Credentials**: Engine tokens and vault keys are ephemeral or revocable, avoiding static plaintext credentials scattered across disk.
- **Frictionless Developer Experience**: Single-user desktop mode requires zero credentials or login screens, while production team deployments gain enterprise-grade access control.

### Negative & Operational Tradeoffs
- **Gateway as Single Point of Policy**: If the Gateway RBAC layer has a defect, underlying engines like Hermes will execute any command since Hermes treats the Gateway's token as fully privileged.
- **Token Synchronization Overhead**: T3 Code sessions require TTL tracking and proactive re-issuance before expiration to prevent WebSocket connection drops during long turns.

---

## Evidence

Refer to the accompanying runnable test suite in `spikes/P0-5-auth-draft/auth-proof.mjs` and verification results in `spikes/P0-5-auth-draft/README.md`.
