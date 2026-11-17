# Spike P0-5 Auth Draft: Neo Auth, Teams & Engine Credential Projection

**Verdict: WORKS**

## Question
Can Neo Gateway implement a unified, multi-tenant auth and team permission system (workspaces, members, roles `owner`/`admin`/`member`/`viewer`, and revocable API tokens) on Node 22 native SQLite (`node:sqlite`) that accommodates zero-setup single-user local desktop mode, multi-tenant VPS team mode, and acts as the secure credential custodian projecting scoped credentials into Hermes Agent, T3 Code, and DeepSeek Harness without exposing raw engines to clients?

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
   - **Better Auth** (v1.2+)
   - **Lucia-style Hand-Rolled Minimal Core**
   - **OIDC-Centric Stack (openid-client)**
   Across local accounts, passkeys, team roles, API tokens, desktop zero-setup, and OIDC upgrade path. Recommends Better Auth with Organization, Passkey, and API Key plugins, paired with a desktop auto-bootstrap bypass middleware.
2. **Engine Credential Map** (in [ADR-auth.md](ADR-auth.md)): Complete table documenting how Neo mints, stores in vault, rotates, and scopes credentials for Hermes Dashboard, Hermes Runtime API, T3 Code, and DSH, detailing what each engine enforces vs what Neo must enforce.
3. **[auth-proof.mjs](auth-proof.mjs)**: Fully self-contained Node 22 (`node:sqlite`) verification script demonstrating local account signup, scrypt password hashing, session issuance (SHA-256 token hashing), workspace creation, member invitation with role `viewer`, RBAC write denial (403 Forbidden) and read permission, scoped API token issuance, authenticated API token write, and instant API token revocation.

---

## Evidence & Verification Commands

The proof was executed with Node v22.23.2 against `node:sqlite` twice in succession. Both runs passed all 9 checks with exit code 0.

### Execution Command
```bash
node spikes/P0-5-auth-draft/auth-proof.mjs
```

### Run 1 Output
```text
[PASS] signup: Created owner (alice.owner@neo.local) and viewer (bob.viewer@neo.local) local accounts
[PASS] login: Authenticated credentials and issued session tokens
[PASS] workspace_create: Created workspace 'Neo Core Team' (ws_546f465f7a44227e)
[PASS] invite_member: Added bob.viewer@neo.local as workspace member with role 'viewer'
[PASS] viewer_write_denied: Write operation by viewer rejected with 403 Forbidden
[PASS] owner_write_permitted: Owner created resource 'Hermes SuperAgent Profile' (res_294c86e18b029cbe)
[PASS] viewer_read_allowed: Viewer successfully read resource 'Hermes SuperAgent Profile'
[PASS] api_token_issue: Issued API token 'ci-deployer-token' with role 'member'
[PASS] api_token_write_permitted: API token created resource 'CI Automated Project'
[PASS] api_token_revoked_blocked: Request using revoked API token rejected with 401 Unauthorized

Final Result: ALL CHECKS PASSED
```

### Run 2 Output (Repeatability & Idempotence)
```text
[PASS] signup: Created owner (alice.owner@neo.local) and viewer (bob.viewer@neo.local) local accounts
[PASS] login: Authenticated credentials and issued session tokens
[PASS] workspace_create: Created workspace 'Neo Core Team' (ws_27a34cc3815f42f2)
[PASS] invite_member: Added bob.viewer@neo.local as workspace member with role 'viewer'
[PASS] viewer_write_denied: Write operation by viewer rejected with 403 Forbidden
[PASS] owner_write_permitted: Owner created resource 'Hermes SuperAgent Profile' (res_f05d8c76ee950147)
[PASS] viewer_read_allowed: Viewer successfully read resource 'Hermes SuperAgent Profile'
[PASS] api_token_issue: Issued API token 'ci-deployer-token' with role 'member'
[PASS] api_token_write_permitted: API token created resource 'CI Automated Project'
[PASS] api_token_revoked_blocked: Request using revoked API token rejected with 401 Unauthorized

Final Result: ALL CHECKS PASSED
```

---

## Architectural Findings & Seam Insights

1. **Downstream Engine RBAC Void**:
   Neither Hermes nor DSH possesses internal team RBAC or user identity concepts. Hermes dashboard treats any client with `X-Hermes-Session-Token` as a superadmin. T3 Code supports granular RPC scopes (`AuthEnvironmentScope`), but has no concept of workspaces, members, or organizations. Neo Gateway is the sole enforcement point for multi-tenant isolation and user permissions.
2. **Token Security Model**:
   Sessions and API tokens must never be stored in plaintext. In `auth-proof.mjs`, bearer tokens use standard prefixes (`neo_sess_...`, `neo_pat_...`) and only their SHA-256 hashes are stored in SQLite, mirroring production security standards.
3. **Desktop Mode Zero-Config Flow**:
   Single-user desktop users expect instant startup without being greeted by a login wall. In desktop mode, Neo Gateway detects the absence of existing users, automatically generates a root admin user and workspace, and writes a session token directly into the local client configuration.
