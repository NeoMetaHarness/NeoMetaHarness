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

`scripts/installer-check.mjs` enforces that the public key is not the placeholder or empty string during release and installer validation, failing immediately if a release bundle is attempted without a configured owner public key. For local development or WebView tests, development builds allow the placeholder key (or pass `--allow-placeholder` / set `NMH_ALLOW_PLACEHOLDER_KEY=true`). In debug builds, `NMH_UPDATER_PUBLIC_KEY` and `NMH_UPDATER_ENDPOINT` environment variables can also override the configuration for local testing.

#### Updater redirect policy and HTTPS enforcement
The updater endpoint URL is strictly required to use HTTPS in production release builds. The underlying HTTP client adheres to system redirection rules; note that any followed redirects must also resolve securely to an authentic target, and minisign signature verification over the binary hash strictly protects against tampered or spoofed release payloads regardless of network transport or redirect targets.

#### Publishing latest.json
To distribute an update:
1. Build signed release bundles with updater artifacts enabled (override `createUpdaterArtifacts: true` in the release environment):
   ```sh
   cargo tauri build --config tauri.bundle.conf.json --config '{"bundle":{"createUpdaterArtifacts":true}}'
   ```
   Tauri compiles the release installer and produces a signature file (e.g., `<bundle>.msi.zip.sig`).
2. Construct `latest.json` describing the release version, release notes, ISO 8601 publish timestamp, and platform-specific signatures and download URLs:
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
       "linux-x86_64": {
         "signature": "<contents of .AppImage.tar.gz.sig>",
         "url": "https://github.com/NeoMetaHarness/NeoMetaHarness/releases/download/v0.2.0/neo-app.AppImage.tar.gz"
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
