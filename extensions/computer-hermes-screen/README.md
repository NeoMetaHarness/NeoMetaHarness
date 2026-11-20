# Hermes bot screen

The `computer-hermes-screen` provider attaches an existing Hermes bot screen using target
`hermes-screen:<profile>`. Enable Hermes and this extension, then attach the profile from Computers.
It is a read-only PNG feed. The shared Computers registry enforces agent policy, human lease,
global kill, action auditing and provider removal. A per-workspace, per-profile
`NEO_SCREEN_VIEW_TOKEN` is held in the encrypted vault. The engine-Hermes bridge verifies it in the same Neo process before connecting to the pinned Hermes dashboard (`extensions/engine-hermes/src/index.ts:38-46`). Hermes separately authenticates its WebSocket using the Hermes dashboard session token.

Hermes v0.23.2 seams are pinned by `upstream/registry.yaml:26`.
`hermes_cli/web_routers/chat_ws.py:650` hosts authenticated JSON-RPC WebSockets.
At v0.23.2, `hermes_cli/web_server_chat.py:311,357` reads the session token from the WebSocket query string. The pinned endpoint does not accept `X-Hermes-Session-Token` as a WebSocket upgrade credential, so this adapter uses the documented query-token seam.
`tui_gateway/methods_display.py:50` serves `display.status`, and line 60
serves `display.thumbnail`, suppressing frames during the native human lease.
`tui_gateway/contracts/display.py:71,89` defines the result schemas.
Hermes's native bot-desktop screenshot comes from `tools/bot_desktop/thumbnail.py:21`; the native human-control lease is in `tools/bot_desktop/lease.py:146,190`. Computer-use remains governed by Hermes.
On hosts without Hermes's Linux bot desktop, the viewer reports unavailable.
