# Threat model: Neo Meta Harness (P7-2, 2026-11)

Scope: the Gateway (`apps/gateway`), auth (`packages/auth`), vault (`packages/vault`), kernel and extension loading (`packages/kernel`), engine projections, the superagent MCP bridge, computer providers, the skills registry, and the Tauri shell (`apps/neo-app/src-tauri`). Findings and fixes are in [review-2026-11.md](review-2026-11.md).

## Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Owner session (desktop token) | `<data>/desktop.token`; Tauri webview URL `?token=` | 30-day owner session: full control of the gateway |
| Better Auth secret | `<data>/auth.secret` | Forges sessions |
| Vault master key + secrets | `<data>/vault-keys/master.key`; `vault_secret` rows | Model/provider API keys, channel bot tokens |
| Projected engine credentials | `HERMES_HOME/.env` (owned block), DSH process env | Same secrets, outside the vault |
| Per-profile callback tokens | vault `NEO_MEMORY_TOKEN`, computer capability tokens | Let an engine write memory or drive a computer |
| API keys | Better Auth `apiKey` table (hashed) | Programmatic access, incl. the superagent bridge |
| Engines' ability to run code | Hermes runs, DSH sessions (arbitrary `cwd`), T3 threads | Effectively shell access as the gateway's OS user |
| Computers | Chrome CDP, VNC, desktop drivers | Browser cookies, screen contents, input injection |
| Memory and skills | memory-local DB, Honcho, skills registry | Poisoned memory/skills steer future agent behaviour |

## Trust boundaries

1. **Loopback TCP to the gateway** (`127.0.0.1:<port>`). Anything on the machine can connect: other OS users and any browser tab (directly, or through DNS rebinding). Only authentication separates them from the owner.
2. **Browser origin to gateway.** App origins (`http://localhost:*`, `http://127.0.0.1:*`, `tauri://localhost`, `http(s)://tauri.localhost`) are trusted for CORS. Every other origin is untrusted.
3. **Roles inside a workspace.** viewer < member < admin < owner, enforced by `apps/gateway/src/policy.ts` (`CONTRACT_POLICY`, `authorize`).
4. **Workspace to workspace.** The vault scopes by `workspaceId`. Most gateway resources (extensions, engines, computers) are global to the instance.
5. **Gateway to engines.** Engines are separate processes that call back over `/internal/*` with per-profile 64-hex tokens.
6. **Gateway to extensions.** Cordis extensions run in-process with `ctx.inject` access to services (including `auth`). Process extensions are child processes that inherit the gateway env.
7. **Skills/Hub content to engines.** Third-party skill text is projected into engine homes.
8. **Tauri shell to webview.** The Rust shell reads `desktop.token` and passes it to the page.

## Attackers

| Attacker | Capabilities | Main targets |
|---|---|---|
| A1. Other local OS user | Connects to loopback ports, reads world-readable files | `/auth/*` sign-up/org/API-key endpoints, CDP port, token files |
| A2. Malicious web page in the user's browser | Cross-origin requests; DNS rebinding to `127.0.0.1`; crafted links to the PWA | Unauthenticated `/auth/*`, CSRF on cookie sessions, `?gateway=` redirection |
| A3. Malicious extension or skill | Code (extension) or instructions (skill) inside the trust boundary | `ctx.inject('auth')`, env secrets, projection paths, agent behaviour |
| A4. Compromised engine | Holds its own callback token; writes into its own home | Other profiles' memory, symlink tricks during projection, other computers |
| A5. Viewer/member escalating | Valid session with a low role | Admin/owner routes, API-key metadata, workspace creation, cross-workspace vault |

## Data flows (security-relevant)

```
Browser/Tauri ──Bearer|cookie|x-api-key──▶ Gateway HTTP ──refuseRequest(Host,Origin)──▶ /auth/* (Better Auth)
                                                     └──resolveAuthContext──▶ oRPC handler ──authorize(policy)──▶ invoke<Ext> ──▶ kernel route
Browser ──WS subprotocol bearer.<t> | ?ticket──▶ /ws ──refuseRequest──▶ resolveAuthContext ──▶ oRPC over WS
Hermes/DSH ──Bearer <64-hex per profile>──▶ /internal/memory/{context,write}   (timingSafeEqual vs vault)
Engine computer_use ──Bearer <capability>──▶ /internal/computers/action ──▶ ComputerRegistry.act
Vault ──projectors──▶ HERMES_HOME/.env (owned block, allowlisted keys) | DSH env allowlist
Superagent ──API key (member, owner-bound)──▶ MCP stdio child ──▶ Gateway oRPC
Tauri shell ──reads desktop.token──▶ webview URL ?token= ──▶ gatewayToken()
```

## Assumptions and non-goals

- **Members can run code on the host.** Hermes runs and DSH sessions execute tools as the gateway's OS user. Any member+ therefore has, in effect, local code execution, and workspaces are **not** an isolation boundary against members. Real multi-tenant isolation needs per-workspace OS sandboxes (out of scope for v1). The role model protects against viewers and unauthenticated callers, not against members.
- Extensions on disk are trusted code. Enabling a discovered extension is admin-only.
- The OS account running the gateway is trusted. Same-user malware is out of scope.
