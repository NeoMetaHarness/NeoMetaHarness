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
- There is no CI release (no GitHub Actions). For a release build, the owner sets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the build shell only, from their own shell or secret store.
- Never commit private key files, `.pem`, `.env`, or credentials to Git. `pnpm installer:check` enforces secret hygiene across build files and configuration.

#### Public key configuration
The owner's base64 public key is **checked in** to `apps/neo-app/src-tauri/tauri.conf.json` under `plugins.updater.pubkey`, replacing the placeholder `REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY`. It is a public key, so committing it is safe. Release builds use that checked-in key. A release `--config` file passed to `cargo tauri build` can also carry it, but the release runbook (`docs/release.md`, task P7-11) keeps the checked-in key and never overrides it.

Don't supply the key through the `TAURI_CONFIG` environment variable alone. `tauri build --config ...` replaces `TAURI_CONFIG` with its merged `--config` arguments, so an environment-only key never reaches the build. Run on its own, `pnpm installer:check` refuses such a key.

The release build fails closed on the key in two places:
- **`beforeBundleCommand`** (`node ../../scripts/installer-check.mjs`, set in `tauri.conf.json` and `tauri.bundle.conf.json`). As a Tauri hook it validates the effective configuration: the checked-in files plus the `--config` arguments, which Tauri hands to the hook in `TAURI_CONFIG`.
- **`build.rs`**. It validates the configuration Tauri compiles into the app: the checked-in file plus the same `--config` merge.

Either check fails the release build on an unresolvable or malformed configuration, or on a missing, empty, placeholder or test key. Debug builds skip them. Development and test builds may use a clearly marked fake test key fixture. In debug builds only, `NMH_UPDATER_PUBLIC_KEY` and `NMH_UPDATER_ENDPOINT` can override the configuration for local testing; release builds ignore both.

#### Updater redirect policy, HTTPS enforcement, allowed hosts, and binary download validation
- **HTTPS endpoint and redirect policy:** The updater endpoint URL is strictly required to use HTTPS in production release builds. The Tauri updater plugin builder (`UpdaterBuilder::configure_client`) configures Reqwest's redirect policy (`Policy::custom`) to enforce that redirects only follow HTTPS (in release builds) and strictly targets trusted hosts in the allowlist.
- **Allowed asset hosts:** The configured update feed uses GitHub Releases (`https://github.com/NeoMetaHarness/NeoMetaHarness/releases/latest/download/latest.json`), where binary asset downloads redirect from `github.com` to GitHub's asset CDN hosts (`objects.githubusercontent.com` and `release-assets.githubusercontent.com`). The desktop shell accepts an explicit allowlist in `tauri.conf.json` (`plugins.updater.allowedHosts`, defaulting to the endpoint host plus GitHub's asset hosts when the endpoint is GitHub). Both the redirect policy and the binary download validation enforce that all redirect destinations and asset download URLs resolve to allowed hosts.
- **Binary download URL validation:** The update manifest (`latest.json`) announces the binary download URL per platform. Because a compromised manifest could attempt to direct downloads to unencrypted HTTP or private internal network addresses, the desktop shell validates the announced `download_url` before initiating any download: the download URL must use HTTPS (in release builds) and its host must match an entry in the allowed hosts list.
- **Cryptographic signature verification:** After download, the updater verifies the payload with the owner's Minisign public key against the signature file, guaranteeing that only authentic, owner-signed binaries can be unpacked or installed.

#### Publishing latest.json
To distribute an update:
1. Build signed release bundles with updater artifacts enabled. The signing key comes from `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the build shell. The public key is the checked-in one:
   ```sh
   cargo tauri build --config tauri.bundle.conf.json --config '{"bundle":{"createUpdaterArtifacts":true}}'
   ```
   With `createUpdaterArtifacts: true`, Tauri v2 signs each installer **as built** and writes a `.sig` next to it under `target/release/bundle/`. Only the macOS app is an archive. Nothing else is zipped or tarred: the updater installs the raw `.exe`, `.msi`, `.AppImage` and `.deb`, and rejects a gzipped `.deb`.

   | Platform key | Updater artifact | Signature |
   |---|---|---|
   | `windows-x86_64-nsis` | `nsis/Neo Meta Harness_X.Y.Z_x64-setup.exe` | `nsis/Neo Meta Harness_X.Y.Z_x64-setup.exe.sig` |
   | `windows-x86_64-msi` | `msi/Neo Meta Harness_X.Y.Z_x64_en-US.msi` | `msi/Neo Meta Harness_X.Y.Z_x64_en-US.msi.sig` |
   | `darwin-aarch64-app` | `macos/Neo Meta Harness.app.tar.gz` | `macos/Neo Meta Harness.app.tar.gz.sig` |
   | `linux-x86_64-appimage` | `appimage/neo-meta-harness_X.Y.Z_amd64.AppImage` | `appimage/neo-meta-harness_X.Y.Z_amd64.AppImage.sig` |
   | `linux-x86_64-deb` | `deb/neo-meta-harness_X.Y.Z_amd64.deb` | `deb/neo-meta-harness_X.Y.Z_amd64.deb.sig` |

   The `.dmg` is for manual installs only. On Linux the app asks for `linux-<arch>-appimage` when it runs from an AppImage, and `linux-<arch>-deb` otherwise.
2. Generate `latest.json` with `scripts/release-manifest.mjs` from the release runbook (task P7-11). Don't write it by hand. The script verifies each `.sig` against its artifact with the checked-in public key. In each URL, GitHub serves the asset name with spaces replaced by dots. For version 0.2.0 the result looks like this:
   ```json
   {
     "version": "0.2.0",
     "notes": "The CHANGELOG.md section for 0.2.0",
     "pub_date": "2026-11-20T12:00:00Z",
     "platforms": {
       "windows-x86_64-nsis": {
         "signature": "<contents of Neo Meta Harness_0.2.0_x64-setup.exe.sig>",
         "url": "https://github.com/NeoMetaHarness/NeoMetaHarness/releases/download/v0.2.0/Neo.Meta.Harness_0.2.0_x64-setup.exe"
       },
       "windows-x86_64-msi": {
         "signature": "<contents of Neo Meta Harness_0.2.0_x64_en-US.msi.sig>",
         "url": "https://github.com/NeoMetaHarness/NeoMetaHarness/releases/download/v0.2.0/Neo.Meta.Harness_0.2.0_x64_en-US.msi"
       },
       "darwin-aarch64-app": {
         "signature": "<contents of Neo Meta Harness.app.tar.gz.sig>",
         "url": "https://github.com/NeoMetaHarness/NeoMetaHarness/releases/download/v0.2.0/Neo.Meta.Harness.app.tar.gz"
       },
       "linux-x86_64-appimage": {
         "signature": "<contents of neo-meta-harness_0.2.0_amd64.AppImage.sig>",
         "url": "https://github.com/NeoMetaHarness/NeoMetaHarness/releases/download/v0.2.0/neo-meta-harness_0.2.0_amd64.AppImage"
       },
       "linux-x86_64-deb": {
         "signature": "<contents of neo-meta-harness_0.2.0_amd64.deb.sig>",
         "url": "https://github.com/NeoMetaHarness/NeoMetaHarness/releases/download/v0.2.0/neo-meta-harness_0.2.0_amd64.deb"
       }
     }
   }
   ```
   The script also adds plain `<os>-<arch>` entries (`windows-x86_64`, `darwin-aarch64`, `linux-x86_64`), which point at the preferred installer.
3. Upload `latest.json` and the updater artifacts to a full (not pre-release, not draft) GitHub release, so that `https://github.com/NeoMetaHarness/NeoMetaHarness/releases/latest/download/latest.json` serves it. The signatures live inside `latest.json`, so the `.sig` files need not be uploaded.
4. The desktop app checks `latest.json` once at startup and caches the result; Settings shows it without another request. Users can also check again from Settings. If a newer stable version is announced, Settings shows an "Update available" badge with the version and an "Install and restart" button, using Astryx components.

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
