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

### Updates and signing

The updater endpoint is configured at `https://github.com/NeoMetaHarness/NeoMetaHarness/releases/latest/download/latest.json`.

#### Key pair generation
The application owner generates the minisign key pair using the Tauri CLI:

```sh
# Generate a new updater signing key pair with an optional password prompt
cargo tauri signer generate -w ~/.tauri/neo.key
# or via pnpm in apps/neo-app:
pnpm --dir apps/neo-app tauri signer generate -w ~/.tauri/neo.key
```

This command outputs:
- A private key file (written to `~/.tauri/neo.key` or a secure location outside the repository).
- A base64 public key printed to stdout.

#### Secret hygiene and private key storage
The private signing key is owned solely by the application owner and **MUST NEVER be committed to Git or stored inside the repository**:
- On local release machines, keep the private key in a secure directory outside the repository (e.g. `~/.tauri/neo.key`).
- In automated release environments or CI, store the private key in CI secrets and provide it via the `TAURI_SIGNING_PRIVATE_KEY` environment variable (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if password-protected).
- Never commit private key files, `.pem`, `.env`, or credentials to Git. `pnpm installer:check` enforces secret hygiene across build files and configuration.

#### Public key configuration
Before building a production release or installer, the owner places the generated base64 public key in `apps/neo-app/src-tauri/tauri.conf.json` under `plugins.updater.pubkey` (replacing the placeholder `REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY`).

The release build path strictly enforces valid public key configuration inside the bundling pipeline via Tauri's `beforeBundleCommand` in `tauri.bundle.conf.json` and `tauri.conf.json` (`node ../../scripts/installer-check.mjs`) as well as in `build.rs`. Both checks inspect the effective merged configuration (including overrides passed via Tauri's `--config` or the `TAURI_CONFIG` environment variable) and fail closed: any error resolving the configuration, malformed JSON, or a missing, empty, or placeholder key fails the release build immediately. Debug builds may skip. Development and test builds may use a clearly marked fake test key fixture (e.g. a sample base64 Minisign public key). In debug builds, `NMH_UPDATER_PUBLIC_KEY` and `NMH_UPDATER_ENDPOINT` environment variables can also override the configuration for local testing.

#### Updater redirect policy, HTTPS enforcement, allowed hosts, and binary download validation
- **HTTPS endpoint and redirect policy:** The updater endpoint URL is strictly required to use HTTPS in production release builds. The Tauri updater plugin builder (`UpdaterBuilder::configure_client`) configures Reqwest's redirect policy (`Policy::custom`) to enforce that redirects only follow HTTPS (in release builds) and strictly targets trusted hosts in the allowlist.
- **Allowed asset hosts:** The configured update feed uses GitHub Releases (`https://github.com/NeoMetaHarness/NeoMetaHarness/releases/latest/download/latest.json`), where binary asset downloads redirect from `github.com` to GitHub's asset CDN hosts (`objects.githubusercontent.com` and `release-assets.githubusercontent.com`). The desktop shell accepts an explicit allowlist in `tauri.conf.json` (`plugins.updater.allowedHosts`, defaulting to the endpoint host plus GitHub's asset hosts when the endpoint is GitHub). Both the redirect policy and the binary download validation enforce that all redirect destinations and asset download URLs resolve to allowed hosts.
- **Binary download URL validation:** The update manifest (`latest.json`) announces the binary download URL per platform. Because a compromised manifest could attempt to direct downloads to unencrypted HTTP or private internal network addresses, the desktop shell validates the announced `download_url` before initiating any download: the download URL must use HTTPS (in release builds) and its host must match an entry in the allowed hosts list.
- **Cryptographic signature verification:** After download, the updater verifies the payload with the owner's Minisign public key against the signature file, guaranteeing that only authentic, owner-signed binaries can be unpacked or installed.

#### Publishing latest.json
To distribute an update:
1. Build signed release bundles with updater artifacts enabled (override `createUpdaterArtifacts: true` in the release environment):
   ```sh
   cargo tauri build --config tauri.bundle.conf.json --config '{"bundle":{"createUpdaterArtifacts":true}}'
   ```
   Tauri compiles the release installer and produces signature files for each target (e.g., `<bundle>.msi.zip.sig`, `<bundle>.AppImage.tar.gz.sig`, `<bundle>.deb.tar.gz.sig`).
2. Construct `latest.json` describing the release version, release notes, ISO 8601 publish timestamp, and package-specific signatures and download URLs:
   ```json
   {
     "version": "0.2.0",
     "notes": "Release notes for version 0.2.0",
     "pub_date": "2026-11-20T12:00:00Z",
     "platforms": {
       "windows-x86_64": {
         "signature": "<contents of .msi.zip.sig>",
         "url": "https://github.com/NeoMetaHarness/NeoMetaHarness/releases/download/v0.2.0/neo-app-0.2.0-x64-setup.nsis.zip"
       },
       "darwin-aarch64": {
         "signature": "<contents of .tar.gz.sig>",
         "url": "https://github.com/NeoMetaHarness/NeoMetaHarness/releases/download/v0.2.0/neo-app.app.tar.gz"
       },
       "linux-x86_64-appimage": {
         "signature": "<contents of .AppImage.tar.gz.sig>",
         "url": "https://github.com/NeoMetaHarness/NeoMetaHarness/releases/download/v0.2.0/neo-app.AppImage.tar.gz"
       },
       "linux-x86_64-deb": {
         "signature": "<contents of .deb.tar.gz.sig>",
         "url": "https://github.com/NeoMetaHarness/NeoMetaHarness/releases/download/v0.2.0/neo-app.deb.tar.gz"
       }
     }
   }
   ```
3. Upload `latest.json` along with the update archives and signatures to the release assets at `https://github.com/NeoMetaHarness/NeoMetaHarness/releases/latest/download/latest.json`.
4. When desktop clients start up or when the user checks for updates in Settings, the app fetches `latest.json`. If a newer version is announced, Settings displays an "Update available" badge with the version and an "Install and restart" button using Astryx components.

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
