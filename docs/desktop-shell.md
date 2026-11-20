# Desktop shell configuration

The Tauri 2 shell runs the local Gateway sidecar and keeps operating system integration in Rust.

The launcher defaults to `Ctrl+Shift+Space`. Set `NMH_LAUNCHER_SHORTCUT` or write
`launcher-shortcut.txt` inside the desktop data directory to customize it. A valid Tauri
global shortcut string is required. Open the tray menu to focus the window, stop agents
through the Gateway's authenticated `computers.kill` route, or quit.

The packaged Windows installer registers `neo://` deep links. The app accepts
`neo://inbox/<id>` and `neo://coding/<thread>`, selects the appropriate page,
and focuses the referenced item or thread when it exists.

The Settings page provides desktop auto-updater management using Astryx components.
The shell checks for updates on startup in the background and on demand when the user
clicks "Check for updates". When an update is available, Settings displays an "Update available"
indicator and an "Install and restart" button.

Endpoints come from configuration (`apps/neo-app/src-tauri/tauri.conf.json`). In custom
deployments, `NMH_UPDATER_ENDPOINT` and `NMH_UPDATER_PUBLIC_KEY` may be supplied via the
environment. The private updater signing key belongs in the owner's secret store (or CI
secrets), supplied to the Tauri bundler using `TAURI_SIGNING_PRIVATE_KEY` and optionally
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Do not place a private key or password in Git or
desktop application configuration. See [Install and updates](install.md#updates-and-signing)
for key generation and `latest.json` publication.
