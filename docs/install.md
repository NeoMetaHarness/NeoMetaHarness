# Install Neo Meta Harness

## Desktop installers

The desktop app uses Tauri 2 and the Astryx frontend. Its packaged gateway runs as a local Node sidecar with separately deployed gateway and extension dependencies. The Tauri shell manages the window, tray, and sidecar process. Gateway owns authentication, bots, extensions, and business logic.

Build on the operating system and architecture that will run the installer. Install Node.js 22+, pnpm 12.9.1, Rust 1.90+, and the Tauri 2 CLI (`cargo install tauri-cli --locked`). Windows builds need the Microsoft C++ toolchain, WebView2, and the NSIS or WiX tooling for the selected package. macOS builds need Xcode command-line tools. Linux builds need the Tauri WebKitGTK development dependencies and the system AppImage/deb packaging tools.

From the repository root:

```sh
pnpm install
pnpm installer:check
pnpm --dir apps/neo-app build
pnpm installer:prepare
```

`installer:prepare` deploys the Gateway and each packaged extension using pnpm, then copies the host Node executable to the architecture-suffixed Tauri sidecar path. Generated files live under `apps/neo-app/src-tauri/installer-payload/` and `apps/neo-app/src-tauri/binaries/`. Both are ignored by Git. Node license text is included with the runtime (set `NMH_NODE_LICENSE` if using a nonstandard Node distribution). Re-run preparation on each target platform, especially when native Node dependencies are involved. Pinned external engines such as Hermes need their documented runtime prerequisites after installation.

Build from `apps/neo-app/src-tauri` with the Tauri CLI, using the bundles appropriate for the local OS:

```sh
cargo tauri build --bundles nsis,msi     # Windows
cargo tauri build --bundles dmg          # macOS
cargo tauri build --bundles appimage,deb # Linux
```

The `beforeBuildCommand` prepares the frontend and bundled sidecar automatically. Test the resulting installer on the target OS with a clean user profile. Gateway binds to loopback, uses desktop-mode authorization, and stores its data in the OS application data directory. The executable can also be run from the development checkout, where the shell uses the local gateway source.

### Updates and signing

The updater endpoint is configured at `https://github.com/NeoMetaHarness/NeoMetaHarness/releases/latest/download/latest.json`. Replace `REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY` in `apps/neo-app/src-tauri/tauri.conf.json` with the real **public** minisign key before distributing signed update manifests. Publish the matching `latest.json` and platform-specific signatures/assets in a release. Until the key and release feed are published, updater delivery remains unconfigured for end users.

Development bundles set `createUpdaterArtifacts` to `false`. For a signed release, set `TAURI_SIGNING_PRIVATE_KEY` and, if needed, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` **in the release environment**, enable updater artifacts using a temporary Tauri config override, and build for each platform. Keep signing keys, passwords, generated payloads, and private certificates out of the repository. `pnpm installer:check` validates the repository configuration offline.

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
