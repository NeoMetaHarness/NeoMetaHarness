# Connected apps (P2-12)

`apps-composio` is the first provider behind the provider-neutral `neo.apps`
interface (`AppsProvider` / `AppsRegistry` in the kernel). Enable the extension,
then configure its endpoint and API key in the existing extension Settings form.
The `secret: true` schema stores the key in Neo's encrypted vault; settings reads
return only its set/unset status. It never enters an engine config or MCP token.
An unconfigured extension or remote outage stays lifecycle-healthy.

## API and connection flow

- `apps.toolkits({provider})`: viewer; lists available toolkits.
- `apps.connect({provider, toolkit, authConfigId, callbackUrl})`: member; returns
  an account ID and OAuth `redirectUrl`. The human must open the link and complete
  authorization. Returning the link does not mean OAuth has completed.
- `apps.run({provider, accountId, action, arguments})`: member; returns completion
  data or a pending Inbox ID. Account IDs must have been connected through Neo.

These installation-owned connections are available to members of this Gateway,
including its member-authorized engine consumers. Keep separate Gateways for
separate trust boundaries. An action cannot select a foreign account by ID.

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

The default endpoint uses HTTPS. HTTP is allowed only on numeric loopback for
self-hosted adapters/tests. Credential-bearing URLs and redirects are rejected.
Errors never echo upstream bodies or credentials. Side effects are never retried
automatically, including after a transport timeout.

## Inbox safety

Provider metadata must explicitly contain `readOnlyHint` and omit
`destructiveHint` to qualify as non-destructive. Missing/unknown metadata is
conservative. Clients cannot supply the destructive classification.

- `observe`: create an Inbox Suggestion; nothing executes until accepted.
- `act-with-approval`: every action creates an approval card.
- `act`: only explicit read-only actions execute immediately; all others wait.

Destructive approval requires admin/owner through the existing Inbox decision
route. The card contains the account, action and exact arguments. Decisions are
consumed before execution, so repeated/concurrent approvals cannot execute twice.
Changing settings or disabling the provider invalidates pending approvals.
Disabling the Inbox blocks execution; listing toolkits and creating links remain
available. Pending callbacks expire on Gateway/Inbox restart: request the action
again. They never replay automatically.

## Engine MCP projection (unmodified)

The existing optional projection bridge now has the generic name
`McpProjectionBridge`; `ComputerMcpBridge` retains compatibility. The independent
apps projection publishes `toolkits`, `connect` and `run` to Hermes, DSH and
superagent. Its capabilities delegate the member action floor and cannot approve
destructive work. Each engine/profile has a separate random vault capability.
Restricted binding files contain that capability, never the Composio key. Every
call rereads its binding and validates profile plus token at the loopback internal
callback. Disable removes files, vault capabilities and Hermes configuration;
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

## Verification

`pnpm test:p2-12` builds the App, then runs adapter tests and an authenticated,
isolated Gateway drill. A scripted random-port fake validates the v3.1 request
shapes; real stdio MCP is exercised by three fake engine consumers. It checks
role enforcement, OAuth links, encrypted settings, all accept modes, destructive
approval, duplicate decisions, settings rotation, token scope, hot disable,
provider outages and unrelated-extension health. No real Composio API, keys,
OAuth accounts, subscriptions or external actions are used.
