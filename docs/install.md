# Install Neo Meta Harness

## Desktop installers

The desktop app uses Tauri 2 and the Astryx frontend. Its packaged gateway runs as a local Node sidecar with separately deployed gateway and extension dependencies. The Tauri shell manages the window, tray, and sidecar process. Gateway owns authentication, bots, extensions, and business logic.

Build on the operating system and architecture that will run the installer. Install Node.js 22+, pnpm 12.9.1, Rust 1.90+, and the Tauri 2 CLI (`cargo install tauri-cli --locked`). Windows builds need the Microsoft C++ toolchain, WebView2, and the NSIS or WiX tooling for the selected package. macOS builds need Xcode command-line tools. Linux builds need the Tauri WebKitGTK development dependencies and the system AppImage/deb packaging tools.

From the repository root:

```sh
pnpm install
pnpm installer:check
pnpm --dir apps/neo-app build
```

`installer:prepare` deploys the Gateway and each packaged extension using pnpm, then copies the host Node executable to the architecture-suffixed Tauri sidecar path. Generated files live under `apps/neo-app/src-tauri/installer-payload/` and `apps/neo-app/src-tauri/binaries/`. Both are ignored by Git. Node license text is included with the runtime (set `NMH_NODE_LICENSE` if using a nonstandard Node distribution). Re-run preparation on each target platform, especially when native Node dependencies are involved. Pinned external engines such as Hermes need their documented runtime prerequisites after installation.

Development `cargo build` and WebView tests use the default Tauri config and do not require staged binaries. Build installers from `apps/neo-app/src-tauri` with the bundle-only Tauri config override, using the bundles appropriate for the local OS:

```sh
cargo tauri build --config tauri.bundle.conf.json --bundles nsis,msi     # Windows
cargo tauri build --config tauri.bundle.conf.json --bundles dmg          # macOS
cargo tauri build --config tauri.bundle.conf.json --bundles appimage,deb # Linux
```

The bundle-only override runs `installer:prepare` from `beforeBuildCommand`, preparing the frontend and packaged sidecar automatically. Run `pnpm installer:prepare` manually only to inspect the generated payload. Test the resulting installer on the target OS with a clean user profile. Gateway binds to loopback, uses desktop-mode authorization, and stores its data in the OS application data directory. The executable can also be run from the development checkout, where the shell uses the local gateway source.

### Updates

The desktop app updates itself from signed GitHub releases.

- **Feed.** It reads `https://github.com/NeoMetaHarness/NeoMetaHarness/releases/latest/download/latest.json`, which GitHub serves from the latest full release.
- **When it checks.** It checks once at startup and caches the result, so **Settings** shows it without another request. Users can check again from **Settings**. Only a stable version with higher precedence counts as an update: pre-releases don't, and build metadata (`+...`) is ignored.
- **Installing.** **Install and restart** in **Settings** downloads the update and verifies its signature with the public key built into the app. It then stops the Gateway sidecar, installs, and starts the new version.
  - On Linux, an install that runs from an AppImage updates that AppImage. Any other install updates as a deb package and restarts the same executable.
- **Downloads.** Downloads and redirects must use HTTPS. They may only go to GitHub and its asset hosts (`plugins.updater.allowedHosts`: `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`). The app refuses any other download URL in the feed before downloading.

#### Public key

The owner's updater public key is **checked in** to `apps/neo-app/src-tauri/tauri.conf.json` under `plugins.updater.pubkey`. It is a public key, so committing it is safe. Until the owner's key is set there, the file holds the placeholder `REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY`.

Release builds fail closed in `build.rs` and in the `beforeBundleCommand` (`scripts/installer-check.mjs`) when any of these is true:
- the key is missing, malformed, the placeholder or a test key;
- the key the build would use differs from the checked-in key.

Release builds run with `TAURI_CONFIG` **unset**. `cargo tauri build` sets it from its `--config` arguments, and a key supplied only through `TAURI_CONFIG` is refused.

The private signing key is created with `cargo tauri signer generate` and kept outside the repository. Never commit it, its password, a `.pem` or a `.env` file; `pnpm installer:check` checks the build files for secrets.

#### Debug-only overrides

In debug builds only, these environment variables override the configuration for local testing against a fake feed:
- `NMH_UPDATER_ENDPOINT`: HTTPS, or loopback HTTP;
- `NMH_UPDATER_PUBLIC_KEY`;
- `NMH_UPDATER_TARGET`;
- `NMH_UPDATER_ALLOWED_HOSTS`.

Release builds ignore all four. Release builds accept only the production endpoint and GitHub's asset hosts.

#### Releasing

Building signed updater artifacts, generating `latest.json` and publishing a release are covered by the release runbook, `docs/release.md` (task P7-11).

## PWA

Build the web app with `pnpm --dir apps/neo-app build` and serve `apps/neo-app/dist/` via HTTPS. The app includes a web manifest and a service worker. Connect it to a reachable Gateway deployment, using an approved same-origin reverse proxy and matching the Gateway's Host and Origin security checks. Install through the browser's **Install app** action. The PWA does not launch the desktop sidecar and needs a separately running Gateway.

## Docker Compose server

Linux Docker Engine with Compose v2 is the supported self-host setup. From the repository root, copy the environment examples to `deploy/config/*.env`, configure the required values and secure those files. Build and start the gateway and Hermes preparation service:

```sh
docker compose --env-file deploy/config/compose.env -f deploy/docker-compose.yml build hermes
docker compose --env-file deploy/config/compose.env -f deploy/docker-compose.yml up -d gateway
docker compose --env-file deploy/config/compose.env -f deploy/docker-compose.yml logs hermes gateway
```

The optional `memory` profile includes Honcho and PostgreSQL. Gateway binds to `127.0.0.1` and the Compose configuration uses Linux host networking, so Windows/macOS users should use a Linux VM. See [Docker Compose instructions](deploy/docker-compose.md) for the exact environment setup, operational checks, optional profile, backup, and security guidance.
