# Desktop shell configuration

The Tauri 2 shell runs the local Gateway sidecar and keeps operating system integration in Rust.

The launcher defaults to `Ctrl+Shift+Space`. Set `NMH_LAUNCHER_SHORTCUT` or write
`launcher-shortcut.txt` inside the desktop data directory to customize it. A valid Tauri
global shortcut string is required. Open the tray menu to focus the window, stop agents
through the Gateway's authenticated `computers.kill` route, or quit.

The packaged Windows installer registers `neo://` deep links. The app accepts
`neo://inbox/<id>` and `neo://coding/<thread>`, selects the appropriate page,
and focuses the referenced item or thread when it exists.

The Settings page provides a **check-only** updater path. Release packaging should set
`NMH_UPDATER_ENDPOINT` to a trusted HTTPS update manifest and
`NMH_UPDATER_PUBLIC_KEY` to its public verification key. The **private** updater signing
key belongs in the release machine's secret store, supplied to the Tauri bundler using
`TAURI_SIGNING_PRIVATE_KEY` and optionally `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
Do not place a private key or password in Git or desktop application configuration.
The updater never installs a release without a separate user-directed workflow.
