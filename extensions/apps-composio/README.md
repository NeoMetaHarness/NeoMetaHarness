# Connected apps (P2-12)

`apps-composio` is the first provider behind the provider-neutral `neo.apps`
interface (`AppsProvider` / `AppsRegistry` in the kernel). Enable the extension,
then configure its endpoint and API key in the existing extension Settings form.
The `secret: true` schema stores the key in Neo's encrypted vault; settings reads
return only its set/unset status. It never enters an engine config or MCP token.
An unconfigured extension or remote outage stays lifecycle-healthy.

## API and connection flow

- `apps.toolkits({provider})`: viewer; lists available toolkits.
- `apps.connect({provider, toolkit, authConfigId})`: member; returns
  an account ID and OAuth `redirectUrl`. The human must open the link and complete
  authorization. Returning the link does not mean OAuth has completed. The Gateway
  supplies its own origin as the callback; callers cannot choose a destination.
- `apps.run({provider, accountId, action, arguments})`: member; returns completion
  data or a pending Inbox ID. Only the connecting user in that workspace can run it.
- `apps.grant({provider, accountId, engine, profile, enabled})`: member and account
  owner; explicitly grants or revokes a named engine profile in the same workspace.
  Revocation is checked again immediately before an approved action executes.

Accounts live in separate hashed workspace directories with an owner user ID.
Composio's entity ID is derived from workspace plus user. Account existence alone
never authorizes use. Legacy installation-wide `accounts.json` records have no
ownership evidence and are ignored: reconnect them under the intended user.

Only HTTP is consumed, with an injected fetch client and no Composio SDK:

- [v3.1 REST reference](https://docs.composio.dev/reference.md).
- [Connect Link](https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsLink):
  `POST /api/v3.1/connected_accounts/link`, `auth_config_id`, `user_id`, `callback_url`.
- [Auth config](https://docs.composio.dev/reference/api-reference/auth-configs/getAuthConfigsByNanoid):
  `GET /api/v3.1/auth_configs/{id}` validates the selected toolkit.
- [Tool metadata](https://docs.composio.dev/reference/api-reference/tools/getToolsByToolSlug):
  `GET /api/v3.1/tools/{slug}` supplies toolkit, tags and version.
- [Execute](https://docs.composio.dev/reference/api-reference/tools/postToolsExecuteByToolSlug):
  `POST /api/v3.1/tools/execute/{slug}` with the reviewed version and connected account.

The default endpoint is `https://backend.composio.dev`. Custom endpoints must use
HTTPS. Private, loopback, link-local, metadata and reserved IPs are denied, including
DNS answers checked in the socket lookup, without a second DNS resolution.
The admin-only `allowPrivateNetwork` setting is off by default and permits private
destinations when explicitly enabled; it never permits HTTP. Credential-bearing
URLs and redirects are rejected. Tests inject a client that maps a synthetic
HTTPS endpoint to the random-port loopback fake; no real key or service is used.
Errors never echo upstream bodies or credentials. Side effects are never retried
automatically, including after a transport timeout.

## Inbox safety

Only exact action IDs in the local read-only allowlist qualify as non-destructive.
Remote `destructiveHint` can make policy stricter; remote `readOnlyHint` never
relaxes it. Unknown actions always require approval, including actions whose
metadata claims they are safe. Clients cannot supply the classification.

- `observe`: create an Inbox Suggestion; nothing executes until accepted.
- `act-with-approval`: every action creates an approval card.
- `act`: only explicit read-only actions execute immediately; all others wait.

Destructive approval requires admin/owner through the existing Inbox decision
route. Viewers see the action and argument keys; member+ reviewers see full
arguments. List and event responses enforce the same redaction and workspace
boundary. Cross-workspace decisions are denied. Decisions are
consumed before execution, so repeated/concurrent approvals cannot execute twice.
Changing settings or disabling the provider invalidates pending approvals.
Disabling the Inbox blocks execution; listing toolkits and creating links remain
available. Pending callbacks expire on Gateway/Inbox restart: request the action
again. They never replay automatically.

## Engine MCP projection (unmodified)

The existing optional projection bridge now has the generic name
`McpProjectionBridge`; `ComputerMcpBridge` retains compatibility. The independent
apps projection publishes `toolkits`, `connect` and `run` to Hermes, DSH and
superagent. The `connect` tool asks an authenticated human to connect through the
App and grant this profile access; it cannot create accounts or choose callbacks.
Its capabilities delegate the member action floor and cannot approve
destructive work. Each engine/profile has a separate random vault capability.
Restricted binding files contain that capability, never the Composio key. Every
call rereads its binding and validates workspace, profile, token and the token's
vault record at the loopback callback. The Apps bridge never falls back to a
shared default workspace: unscoped Hermes/superagent profiles get no token or tool
until an owner grant assigns their workspace. DSH supplies its session workspace.
One profile cannot be rebound across workspaces. Disable removes files, vault capabilities and Hermes configuration;
engine tools then fail clearly while the engines remain healthy.

Pinned seams (also documented by `computers-mcp`):

- Hermes `v0.23.2`, `tools/mcp_tool_transport.py:375-395`,
  `tools/mcp_tool_discovery.py:544-564`, `tools/mcp_tool_registration.py:363-368`:
  isolated `mcp_servers.neo_apps` and `mcp-neo_apps` toolset.
- DSH `0.2.2-rc.1`, `packages/mcp/mcp-client/src/index.ts:51-78,154`:
  stdio MCP client in the isolated profile patch.
- Superagent `8c32a9dc5d72`, `cordis.patch.yml:20-26`,
  `src/app/sessions.ts:47-52,122-130`: worker-preset MCP client mount.

No upstream engine files or user engine homes are changed. Enable the extension
before starting a DSH session/worker; existing DSH sessions discover newly enabled
projections on their next session. Hermes refreshes its projection at run startup.

## Merge dependency

The Hermes startup/cleanup fix was kept in P6-9 and landed on main as `aeedfc3`.
This branch consumes it through the rebase; it does not duplicate that fix.
The P2-12 transport drill uses fake engine consumers, as required by this task.

## Verification

`pnpm test:p2-12` builds the App, then runs adapter tests and an authenticated,
isolated Gateway drill. A scripted random-port fake validates the v3.1 request
shapes; real stdio MCP is exercised by three fake engine consumers. It checks
role enforcement, OAuth links, encrypted settings, all accept modes, destructive
approval, duplicate decisions, settings rotation, token scope, hot disable,
provider outages and unrelated-extension health. A scripted real DSH preset worker
also runs multiple apps tools, reports the final result, and surfaces pending
approval as a question without executing the destructive action. No real Composio API, keys,
OAuth accounts, subscriptions or external actions are used.
