# Channels extension — P2-5 Telegram

`extensions/channels` exposes Hermes messaging adapters through Neo's gateway. The first supported connection is Telegram, with one bot token per Hermes profile. The Astryx Channels page is lazy-loaded under Settings at `/settings/channels`, and uses only `x.channels.list / status / connect / disconnect` oRPC procedures.

## Pinned Hermes seams

Hermes comes from `upstream.lock.json` at the `hermes-agent@v0.23.2` cache. These references identify the exact upstream seams used, without upstream changes.

- `hermes_cli/web_routers/messaging.py:989-1001` implements `GET /api/messaging/platforms?profile=...`. The catalog is supplied by Hermes and exposed by Neo as platform metadata. This is how the UI discovers all platforms.
- `hermes_cli/web_routers/messaging.py:1048-1114` implements `PUT /api/messaging/platforms/{platform_id}` with profile-scoped configuration. Neo sends `enabled` without a token and uses Hermes' profile-bound settings.
- `plugins/platforms/telegram/adapter.py:2939-2945` accepts Telegram's `extra.base_url` and `extra.base_file_url` through python-telegram-bot's request builder. The two test suites redirect Telegram API calls to a loopback fake Bot API with these settings.
- `gateway/run.py:5065-5081` exposes the gateway entry point. `gateway/config_loader.py:578-586` shows that an explicit `--config` loads `GatewayConfig.from_dict` without the normal environment overlay. The channel launcher uses `python -u -m gateway.run`, with `HERMES_HOME` pointing to the target Neo-owned profile so projected environment configuration is applied.

Hermes' platform adapters and its dashboard run as installed from the pinned upstream cache. The channel extension launches an isolated gateway per connected profile.

## Secrets and ownership

The Telegram token is an encrypted vault entry in scope `engine-hermes/<profile>`, workspace `default`. The `HermesProjector` writes the `TELEGRAM_BOT_TOKEN` into that profile's `.env`, bounded by its owned-key markers. It updates those markers on token rotation and removes only the owned entry on disconnect. Channel lists and statuses expose metadata only. The token field is password-masked, write-only, and cleared after connect. Gateway subprocess environments are built from the `DshProjector` allowlist and explicitly assigned the Neo-owned `HERMES_HOME`.

The test-only `NMH_CHANNELS_TELEGRAM_API_BASE` must specify an HTTP loopback address at `127.0.0.1` with an explicit port. Tests set it to a local fake Telegram Bot API and use an isolated `NMH_HERMES_HOME` under the OS temporary directory. Production runs omit the override. No real Telegram credentials or user's Hermes profile are used.

## Verification

`pnpm --dir extensions/channels test` exercises platform discovery, encrypted storage, Hermes polling, inbound Telegram message to scripted model to outbound Telegram reply, rotation, disconnect preserving a user-written `.env` line, and extension disable without disruption to other extensions.

`pnpm --dir apps/neo-app test:p2-5` builds the current frontend, verifies startup JavaScript stays under 300 KB gzip, drives the lazy Channels UI in isolated Chrome over CDP, sends a message through the fake Telegram API, and verifies visible status, token clearing, disconnect, and disabled state. Both suites use temporary homes and local fake services.
