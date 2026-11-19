# Computer MCP projection and shared safety

Enable `computers-mcp` to expose the assigned Neo computer to Hermes, DSH and
superagent workers. The stdio MCP server supplies `screenshot`, `click`, `type`,
`key`, `navigate`, and `lease_status`. It never attaches a desktop implicitly:
assign one using the authenticated admin `computers.assign` procedure. Hermes
uses the profile name, DSH uses the SDK session ID, and a superagent worker uses
the bot ID as its assignment target. DSH assignments are removed at session end.

## Engine seams (unmodified pins)

- Hermes `v0.23.2`, `tools/mcp_tool_transport.py:375-395`: configured stdio
  command, args and environment. `tools/mcp_tool_discovery.py:544-564` registers
  `mcp_servers`; `tools/mcp_tool_registration.py:363-368` uses the per-server
  `mcp-<name>` toolset. Neo writes only `mcp_servers.neo_computers` and its
  `mcp-neo_computers` API-server toolset entry in the isolated profile config.
- DSH `0.2.2-rc.1`, `packages/mcp/mcp-client/src/index.ts:51-78,154`: stdio
  configuration and Cordis plugin activation. Neo adds a profile-patch plugin
  pointing to that pinned MCP client; it does not change engine source.
- Superagent `8c32a9dc5d72`, `cordis.patch.yml:20-26`: worker-preset plugin list;
  `src/app/sessions.ts:47-52,122-130`: preset selection for executor sessions.
  Neo's existing isolated preset worker host mounts the same pinned DSH MCP
  client in the worker's scope, alongside its delegation MCP client.

The registry pins these engines in `upstream.lock.json`. MCP projection uses the
existing Hermes plugin/config and DSH profile/worker-preset seams. It introduces
no patched engine, engine fork, embedded UI or user-home configuration.

## Credentials and lifecycle

Each engine/profile has an independent 32-byte random capability, stored as
`NEO_COMPUTER_MCP_TOKEN` in its engine/profile vault scope. A restricted local
binding file projects the capability into the isolated engine home. Engine
configuration contains the file path, never the token. The MCP server re-reads
the binding file for every tool call and sends it only to the loopback internal
Gateway callback. The callback validates it with `timingSafeEqual`, then obtains
the current assignment from the registry; a caller cannot select another screen
or profile using a tool argument. Desktop/session tokens grant no authority to
this callback.

Disable removes binding files and vault records, removes Neo's Hermes config
entry, and detaches the projection. Already-running MCP servers keep responding
to initialization/listing and return a tool error for actions. Engines stay
healthy. Re-enable reprojects remembered consumers with new tokens, invalidating
old capabilities. Engine/session shutdown revokes its projection credentials.

## Safety policy

The computer registry applies the same checks to legacy engine actions and MCP
calls, before invoking any provider:

- A human lease blocks agent input and screenshots; `lease_status` remains readable.
- The kill switch blocks agent input and screenshots.
- Destructive/unknown key chords are denied by default. Admin/owner
  `computers.policy.set` can permit them per attached computer.
- Navigation is denied by default. Its requested URL must use HTTP(S), contain
  no embedded credentials and match an exact operator-allowed origin. The provider
  must implement navigation; unsupported desktops fail clearly. Headless Chrome
  and local sandbox share the Chrome implementation; VNC has no browser-native
  navigation operation.
- `computer.action` events record engine/profile, computer/provider, operation and
  allowed/denied/failed outcome. They omit typed text, key values, URLs, screenshots
  and tokens. Events use the existing bounded Gateway event stream; this task does
  not introduce a durable audit database.

Example operator policy (authenticated admin/owner oRPC):

```ts
await client.computers.policy.set({
  id: 'assigned-screen',
  allowDestructiveKeys: false,
  navigationOrigins: ['https://example.test'],
});
```

Policy defaults reset when the screen is released and attached again. These gates
are an agent action policy, not an OS or network sandbox: arbitrary visual input
and browser redirects require the operator's normal desktop trust boundary.

## Verification

`pnpm test:p3-7` builds the App first and checks all three engine adapters, the
registry policy, real stdio MCP protocol/tools, vault isolation and an authenticated
Gateway. Fake engine consumers and provider doubles exercise the 3 x 4 matrix
(Hermes/DSH/superagent x fake/headless Chrome/local sandbox/VNC). The pinned, unmodified DSH MCP client also discovers and executes a screenshot
for DSH and superagent configs against a fake computer. No real desktop,
browser, VNC server, model subscription or user engine home is needed. The existing
computers and Gateway regression suites are run separately.
