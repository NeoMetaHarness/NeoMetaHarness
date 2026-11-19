# Channels extension — P2-5 Telegram, P6-5 WhatsApp

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

## WhatsApp (P6-5)

WhatsApp runs on Hermes' own WhatsApp platform (`plugins/platforms/whatsapp`, a Python adapter polling a local Node bridge). Hermes is unmodified; Neo only uses its public seams at v0.23.2:

- **Connect** `x.channels.connect {profile, platform:'whatsapp', botId}` (admin). WhatsApp has no API token; the device is linked by QR in Hermes (`hermes whatsapp`, or the dashboard's WhatsApp onboarding). `status` reports `paired` once `creds.json` exists. Neo enables the platform via the dashboard API, gives the profile its own `platforms.whatsapp.extra.bridge_port`, and launches `gateway.run` with `WHATSAPP_MODE=bot`, `WHATSAPP_DM_POLICY=pairing`, `WHATSAPP_GROUP_POLICY=disabled` (DMs only in this slice).
- **Node runtime.** The adapter runs the bridge only with a Node installed by Hermes' package manager (`hermes_constants.py:587-609`; never `PATH`). Connect runs `hermes pm install node` once (pinned, sha256-checked in `pm/lock.json`) into a shared PM store (`HERMES_RUNTIME_DIR`, `pm/environments.py:220-232`). The store is under the extension data dir by default; `NMH_HERMES_RUNTIME_DIR` overrides it.
- **Inbound.** Neo installs a user plugin, `neo-channels` (`src/whatsapp-plugin`, enabled through `plugins.enabled`). It hooks `pre_gateway_dispatch` (`hermes_cli/plugins.py:142-145`, `gateway/run_inbound_hooks.py:74-110`), which runs before Hermes' authorization, and offers each WhatsApp message to `POST /internal/channels/whatsapp/inbound`. The callback carries a per-profile 64-hex token (`NEO_CHANNELS_TOKEN`, encrypted in the vault, written to the plugin's 0600 `binding.json`, checked with `timingSafeEqual`). A DM from an allowlisted sender that mentions `@neo` becomes a `neo/channel` Inbox item (the sender's Neo role, the connected bot), and Hermes skips it. Every other message, and any Neo outage, is left to Hermes.
- **Replies.** Inbox reports come back through the gateway channel bus. They are sent with `hermes send --to whatsapp:<jid>` (`hermes_cli/send_cmd.py:196-289`), which talks to the bridge itself.
- **Senders.** `x.channels.allow/revoke/senders` (admin) manage the allowlist: phone number to role (`viewer`, `member` or `admin`; never owner). It is passed to Hermes as `WHATSAPP_ALLOWED_USERS` (the gateway restarts to apply it). An unknown sender gets a Hermes pairing code (`gateway/pairing.py`). `x.channels.approve {code, role}` runs `hermes pairing approve whatsapp <code>` and admits the sender read from Hermes' approved store. Revoke also revokes the Hermes approval. The allowlist lives in `<extension data>/channels/state.json` (0600).
- **Disable/disconnect.** Disconnect stops the gateway, disables the platform, deletes the vault token and removes the plugin. Disabling the extension stops the Hermes gateway and its bridge (on POSIX the bridge leads its own session, so it is stopped through Hermes' `bridge.pid` while it is still our child). The callback endpoint then answers 404, so the plugin falls back to Hermes.

`pnpm --dir extensions/channels test` also runs `test/whatsapp.e2e.test.ts`. It uses a fake bridge (`test/fixtures/whatsapp-bridge`, set as `extra.bridge_script` through `NMH_CHANNELS_WHATSAPP_BRIDGE_SCRIPT`, honoured only with `NODE_ENV=test`), scripted Hermes and superagent models, and an isolated temp home with desktop-token auth. The first run downloads Hermes' pinned Node into a shared PM store at `<os tmpdir>/nmh-hermes-runtime` (outside the repo; override with `NMH_HERMES_RUNTIME_DIR`), and later runs reuse it.
