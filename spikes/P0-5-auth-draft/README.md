# Spike P0-5 Auth Draft: Neo Auth, Teams & Engine Credential Projection

**Verdict: WORKS**

## Question
Can Neo Gateway implement a unified, multi-tenant auth and team permission system (workspaces, members, roles `owner`/`admin`/`member`/`viewer`, and revocable API tokens) on Node 22 native SQLite (`node:sqlite`) with Kysely that accommodates zero-setup single-user local desktop mode, multi-tenant VPS team mode, and acts as the secure credential custodian projecting scoped credentials into Hermes Agent, T3 Code, and DeepSeek Harness without exposing raw engines to clients?

---

## Pinned References & Seams

- **Hermes Agent**: Pinned ref `hermes-agent@v0.23.2` (`ae2a81c47285a85fd248d64d50937c86a11e1ee3`).
  - Dashboard API: `hermes_cli/web_server.py:657` (`_has_valid_session_token`), `hermes_cli/web_server_session_token.py:42`. Header: `X-Hermes-Session-Token` or `Authorization: Bearer <token>`.
  - Runtime API: `gateway/platforms/api_server.py:756` (`APIServerAdapter._check_auth`), `gateway/config.py:112`. Header: `Authorization: Bearer <API_SERVER_KEY>` (min 16 chars).
  - Upstream enforcement: Binary/profile-level only; no internal RBAC or user scoping. All member tenancy and role permissions are enforced upstream by Neo Gateway.
- **T3 Code**: Pinned ref `t3code@v0.1.9` (`24e77473ecf41bc1f7142529c7911c1c1aae1d76`).
  - Auth contract & scopes: `packages/contracts/src/auth.ts:32` (`AuthEnvironmentScope` 17 scopes: `orchestration:read`, `orchestration:operate`, `settings:write`, `providers:manage`, etc.).
  - Token minting & issuance: `apps/server/src/cli/auth.ts:182` (`t3 auth session issue`), `apps/server/src/auth/EnvironmentAuth.ts:182`.
  - HTTP & WebSocket ticket verification: `apps/server/src/auth/http.ts:94`, `packages/client-runtime/src/rpc/protocol.ts:42`.
  - Upstream enforcement: Granular RPC method middleware (`RpcScopeAuthorization`). Neo maps user roles to minimal T3 scope sets.
- **DeepSeek Harness (DSH)**: Pinned ref `deepseek-harness@0.2.2-rc.1` / `dsh-superagent@8c32a9dc5d72`.
  - Interface: Stdio SDK IPC (`stdin`/`stdout`).
  - Credential mechanism: Process environment variables (`DEEPSEEK_API_KEY`) and credentials file injected directly by Neo Vault at spawn time. Security perimeter is the process boundary.

---

## Deliverables in this Spike

1. **[ADR-auth.md](ADR-auth.md)**: Architectural Decision Record comparing:
   - **Better Auth** (`better-auth@1.7.25`, `@better-auth/kysely-adapter@1.7.25`, `kysely@0.28.8`)
   - **Lucia-style Hand-Rolled Minimal Core** (`node:sqlite` + `crypto.scryptSync`)
   - **OIDC-Centric Stack (openid-client)**
   Recommends Better Auth for multi-tenant / team VPS mode with the verified Kysely `node:sqlite` driver bridge, while preserving the hand-rolled core as the zero-dependency baseline.
2. **Engine Credential Map** (in [ADR-auth.md](ADR-auth.md)): Complete operational table documenting how Neo mints, stores in vault, rotates, and scopes credentials for Hermes Dashboard, Hermes Runtime API, T3 Code, and DSH, detailing what each engine enforces vs what Neo must enforce.
3. **[auth-proof-better-auth.mjs](auth-proof-better-auth.mjs)**: Real Better Auth proof (`better-auth@1.7.25`) with `organization` and `bearer` plugins over Kysely and Node 22 native `node:sqlite`. Proves all 10 checks including signup, login, organization creation, viewer invitation, viewer write 403 rejection via Better Auth permissions, owner write permission, viewer read, API token issuance, API token write, and token revocation (401).
4. **[auth-proof.mjs](auth-proof.mjs)**: Hand-rolled baseline reference proof with zero external dependencies, proving the same 10 checks.

---

## Technical Findings on Better Auth + Kysely + `node:sqlite`

1. **Prepared Statement Detection (`stmt.columns().length > 0`)**:
   Kysely's `SqliteDialect` relies on `stmt.reader` (from `better-sqlite3`) to distinguish queries yielding rows from those performing writes. Node 22's native `DatabaseSync` does not have a `.reader` property. Better Auth executes CTEs (`with "table_list" as ...`), PRAGMAs, and SQLite 3.35+ `RETURNING *` clauses (`insert into "user" ... returning *`). Using `reader: stmt.columns().length > 0` correctly identifies statements returning result rows, avoiding silent row discarding (`SchemaMismatchError` and `FAILED_TO_CREATE_USER`).
2. **Plugin Architecture & API Keys**:
   `better-auth@1.7.25` does not export an `apiKey` plugin from `better-auth/plugins`. Personal access tokens (PATs) and CI tokens are created as scoped bearer session tokens and authenticated via Better Auth's official `bearer()` plugin (`headers: { authorization: 'Bearer <token>' }`). Revocation is performed via `auth.api.revokeSession`.
3. **Role Merging in Organization Plugin**:
   Passing custom roles to `organization({ roles: { ... } })` replaces default roles unless explicitly merged: `{ ...defaultRoles, viewer: viewerRole }`.
4. **Plural `permissions` in `hasPermission`**:
   The `auth.api.hasPermission` endpoint expects `body: { permissions: { resource: [action] } }` (plural); passing singular `permission` fails validation.

---

## Evidence & Verification Commands

### 1. Better Auth Implementation (`auth-proof-better-auth.mjs`)
Executed with Node v22.23.2 against Kysely and fresh temporary SQLite databases twice in succession:

```bash
node spikes/P0-5-auth-draft/auth-proof-better-auth.mjs
```

#### Run 1 Output:
```text
[PASS] signup: Created owner (alice.owner@neo.local) and viewer (bob.viewer@neo.local) via Better Auth signUpEmail
[PASS] login: Authenticated credentials and issued bearer session tokens via Better Auth signInEmail
[PASS] workspace_create: Created organization 'Neo Core Team' (XpTt2tIrYm6cH9U2YRX02K23Yv7ZHDXq) via Better Auth createOrganization
[PASS] invite_member: Added bob.viewer@neo.local as organization member with role 'viewer'
[PASS] viewer_write_denied: Write operation by viewer rejected with 403 Forbidden via Better Auth org permissions
[PASS] owner_write_permitted: Owner created resource 'Hermes SuperAgent Profile' (res_2b7642f2a288f977)
[PASS] viewer_read_allowed: Viewer successfully read resource 'Hermes SuperAgent Profile'
[PASS] api_token_issue: Issued scoped API bearer token 'neo_pat_c5634346...' linked to workspace
[PASS] api_token_write_permitted: API token created resource 'CI Automated Project' (res_84e752d8054aeb36)
[PASS] api_token_revoked_blocked: Request using revoked API token rejected with 401 Unauthorized via Better Auth revokeSession

Final Result: ALL CHECKS PASSED
```

#### Run 2 Output (Repeatability & Clean State):
```text
[PASS] signup: Created owner (alice.owner@neo.local) and viewer (bob.viewer@neo.local) via Better Auth signUpEmail
[PASS] login: Authenticated credentials and issued bearer session tokens via Better Auth signInEmail
[PASS] workspace_create: Created organization 'Neo Core Team' (Agu6HE7xv0o1oF9A3JWpVGVia1W6SbLi) via Better Auth createOrganization
[PASS] invite_member: Added bob.viewer@neo.local as organization member with role 'viewer'
[PASS] viewer_write_denied: Write operation by viewer rejected with 403 Forbidden via Better Auth org permissions
[PASS] owner_write_permitted: Owner created resource 'Hermes SuperAgent Profile' (res_b3f0413b27f40256)
[PASS] viewer_read_allowed: Viewer successfully read resource 'Hermes SuperAgent Profile'
[PASS] api_token_issue: Issued scoped API bearer token 'neo_pat_4d5bc740...' linked to workspace
[PASS] api_token_write_permitted: API token created resource 'CI Automated Project' (res_1773b697ad3434e5)
[PASS] api_token_revoked_blocked: Request using revoked API token rejected with 401 Unauthorized via Better Auth revokeSession

Final Result: ALL CHECKS PASSED
```

---

### 2. Baseline Implementation (`auth-proof.mjs`)
Executed with Node v22.23.2 against `node:sqlite`:

```bash
node spikes/P0-5-auth-draft/auth-proof.mjs
```

#### Run Output:
```text
[PASS] signup: Created owner (alice.owner@neo.local) and viewer (bob.viewer@neo.local) local accounts
[PASS] login: Authenticated credentials and issued session tokens
[PASS] workspace_create: Created workspace 'Neo Core Team' (ws_970b7445728af4fb)
[PASS] invite_member: Added bob.viewer@neo.local as workspace member with role 'viewer'
[PASS] viewer_write_denied: Write operation by viewer rejected with 403 Forbidden
[PASS] owner_write_permitted: Owner created resource 'Hermes SuperAgent Profile' (res_dbb982d78bb7b256)
[PASS] viewer_read_allowed: Viewer successfully read resource 'Hermes SuperAgent Profile'
[PASS] api_token_issue: Issued API token 'ci-deployer-token' with role 'member'
[PASS] api_token_write_permitted: API token created resource 'CI Automated Project'
[PASS] api_token_revoked_blocked: Request using revoked API token rejected with 401 Unauthorized

Final Result: ALL CHECKS PASSED
```
