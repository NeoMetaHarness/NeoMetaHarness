# Hermes bot screen

The `computer-hermes-screen` provider attaches an existing Hermes bot screen using target
`hermes-screen:<profile>`. Enable Hermes and this extension, then attach the profile from Computers.
It is a read-only PNG feed. The shared Computers registry enforces agent policy, human lease,
global kill, action auditing and provider removal. A per-workspace, per-profile
`NEO_SCREEN_VIEW_TOKEN` is held in the encrypted vault and checked by Hermes before a connection.

Hermes v0.23.2 seams are pinned by `upstream/registry.yaml:26`.
`hermes_cli/web_routers/chat_ws.py:650` hosts authenticated JSON-RPC WebSockets.
`tui_gateway/methods_display.py:50` serves `display.status`, and line 60
serves `display.thumbnail`, suppressing frames during the native human lease.
`tui_gateway/contracts/display.py:71,89` defines the result schemas.
Hermes's native computer-use and RFB observation seams remain owned by Hermes.
On hosts without Hermes's Linux bot desktop, the viewer reports unavailable.
