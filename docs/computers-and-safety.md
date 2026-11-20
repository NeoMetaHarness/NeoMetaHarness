# Computers and Safety Policy

Neo Meta Harness provides a unified computer abstraction across local desktops, container sandboxes, remote displays, and virtual network computers (VNC). The Computers registry (`packages/computers/src/index.ts:36-60`) and Gateway routes (`apps/gateway/src/server.ts:1082-1135`) govern capability tokens, active input leases, synchronous preemption, and safety policies.

## Local desktop provider (computer-local)

The `computer-local` extension (`extensions/computer-local/README.md`, `extensions/computer-local/src/provider.ts`) attaches an operator's local Windows, macOS, or Linux desktop for agent interaction without cloud virtualization or third-party screen relays.

### Opt-in consent model

Local desktop access is disabled by default to protect user workstations. Enabling the extension does not automatically grant agents access to host input or displays. An administrator or owner must explicitly record consent via the Gateway endpoint:

- **Endpoint:** `computers.local.set({ enabled: true })` (`apps/gateway/src/server.ts:1138-1150`, `packages/contracts/src/index.ts:492-495`).
- **Authorization:** Enforced by `apps/gateway/src/policy.ts:161`, requiring an `admin` or `owner` role.

Once consent is granted, the single target `local-desktop` becomes available for attachment through `computers.attach({ providerId: 'computer-local', target: 'local-desktop' })`. Revoking consent via `computers.local.set({ enabled: false })` immediately terminates the running driver process, releases the target, and invalidates all active capability tokens.

### Driver protocol (NEO_CUA_DRIVER_PATH)

The provider delegates operating system interactions to an operator-installed Computer-Use Agent (CUA) driver binary specified by the absolute path environment variable `NEO_CUA_DRIVER_PATH` (`extensions/computer-local/src/provider.ts:11-30`):

- **Process invocation:** The driver process is spawned directly with argument `--stdio-json`, with no shell wrapper (`extensions/computer-local/src/provider.ts:18-22`).
- **Communication:** Communication occurs over `stdio` using newline-delimited JSON-RPC messages formatted as `{ id, method, params }` and `{ id, result }` or `{ id, error }`.
- **Supported driver methods:**
  - `screenshot`: Returns `{ png, width, height }` where `png` is a base64-encoded PNG image string.
  - `click`: Receives `{ x, y }` screen coordinates.
  - `move`: Receives `{ x, y }` screen coordinates.
  - `type`: Receives text string to input.
  - `key`: Receives key combinations or symbols.
  - `scroll`: Receives `{ direction, amount }`.

Automated unit and integration tests inject an in-memory mock driver and never launch external binaries (`extensions/computer-local/README.md:15-17`).

### Human lease takeover and synchronous preemption

Neo enforces a strict lease model (`packages/computers/src/index.ts:223-234`):

- **Lease holders:** A computer can be leased to either `'agent'` or `'human'`.
- **Preemption:** When an operator takes over control in the Computers UI or the Gateway assigns `holder: 'human'`, the registry immediately invokes `computer.interrupt?.()` on the driver adapter. This cancels active native input synchronously before queued background tasks drain.
- **Agent lockout:** While leased to a human, any subsequent agent action through `act()` is rejected with `Computer is leased to a human` (`packages/computers/src/index.ts:267`).

### Global kill switch

The global kill switch provides an emergency stop mechanism across all attached computers:

- **Endpoint:** `computers.kill.set({ engaged: true })` (`apps/gateway/src/server.ts:1108-1111`, `packages/computers/src/index.ts:192-205`).
- When engaged, all active driver inputs are interrupted, executing actions are aborted, and new agent actions fail with `Computer kill switch engaged`.

## Hermes screen viewer (computer-hermes-screen)

The `computer-hermes-screen` extension (`extensions/computer-hermes-screen/README.md`, `extensions/computer-hermes-screen/src/provider.ts`) provides a read-only visual viewport into Hermes Linux bot desktops.

### Architecture and WebSocket transport

Rather than emulating a full interactive desktop locally, this provider connects to the bot's authenticated Hermes WebSocket server:

- **Target identifier:** `hermes-screen:<profile>`, where `<profile>` matches an existing Hermes agent profile.
- **WebSocket connection:** Connects via authenticated JSON-RPC to `hermes_cli/web_routers/chat_ws.py:650`.
- **Vault credentials:** Authentication relies on a per-workspace, per-profile token named `NEO_SCREEN_VIEW_TOKEN`, stored securely in Neo's encrypted vault (`extensions/computer-hermes-screen/src/provider.ts:45-75`, `apps/gateway/src/server.ts:1072-1080`).

### Display RPC methods and lease suppression

The provider invokes display methods defined in Hermes's TUI gateway:

- `display.status` (`tui_gateway/methods_display.py:50`): Checks display server health and active resolution.
- `display.thumbnail` (`tui_gateway/methods_display.py:60`): Fetches base64-encoded PNG screenshots originating from Hermes's bot-desktop thumbnail capture (`tools/bot_desktop/thumbnail.py:21`).
- **Human control lease:** If a human operator assumes the native control lease in Hermes (`tools/bot_desktop/lease.py:146,190`), thumbnail generation automatically suppresses frame capture to protect operator privacy.
- **Host fallback:** If Hermes is deployed on an operating system without Linux Xfce bot-desktop support, the viewer safely reports `unavailable` without crashing the Gateway.

## Computer safety policy (P3-7)

To prevent unconstrained agent actions from damaging host environments or exfiltrating data, every computer in Neo is subject to a strict, deny-by-default safety policy (`packages/computers/src/index.ts:237-285`).

### Deny-by-default security model

When a computer is first provisioned or attached, its safety policy is initialized to:

```json
{
  "allowDestructiveKeys": false,
  "navigationOrigins": []
}
```

Under these default settings:

1. **Destructive keys are blocked:**
   - Single alphanumeric characters (`[a-z0-9]`) and safe navigation keys (`enter`, `return`, `tab`, `esc`, `escape`, `space`, `left`, `right`, `up`, `down`, `arrowleft`, `arrowright`, `arrowup`, `arrowdown`, `home`, `end`, `pageup`, `pagedown`) are permitted.
   - Deletion keys (`backspace`, `delete`) and control chords (`ctrl+c`, `ctrl+w`, `alt+f4`, etc.) are blocked with `Key blocked by computer safety policy` (`packages/computers/src/index.ts:269-272`).
2. **Arbitrary browser navigation is blocked:**
   - Any `navigate(url)` call is blocked unless the URL's origin is explicitly listed in `navigationOrigins` (`packages/computers/src/index.ts:274-278`).
   - URLs must use the `http:` or `https:` protocol and cannot include embedded credentials (`username` or `password`).

### Admin policy configuration (computers.policy.set)

An administrator can opt a computer into expanded capabilities using the policy endpoints (`packages/contracts/src/index.ts:486-490`, `apps/gateway/src/server.ts:1083-1089`):

- **Get policy:** `computers.policy.get({ id: string })` (requires `admin` role per `apps/gateway/src/policy.ts:154`).
- **Set policy:** `computers.policy.set({ id: string, allowDestructiveKeys: boolean, navigationOrigins: string[] })` (requires `admin` role per `apps/gateway/src/policy.ts:155`).

Example payload:

```json
{
  "id": "local-desktop",
  "allowDestructiveKeys": true,
  "navigationOrigins": [
    "https://github.com",
    "https://console.cloud.google.com"
  ]
}
```

The Gateway verifies that every entry in `navigationOrigins` is a valid HTTP(S) origin. Malformed entries or origins containing path components are rejected.

### Action auditing

Every action executed by an agent publishes an audit event to the event stream (`packages/computers/src/index.ts:255-263`):

- **Event type:** `computer.action`
- **Fields:** `computerId`, `providerId`, `engine`, `targetId`, `action`, and `outcome` (`'allowed'`, `'denied'`, or `'failed'`).
