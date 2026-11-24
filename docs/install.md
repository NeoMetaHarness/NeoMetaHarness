# Install Neo Meta Harness

## Install dependencies

From the repository root, on Node.js 22.12+ with pnpm 12.9.1:

```sh
pnpm install
```

pnpm 12 blocks dependency build scripts that are not approved. `pnpm-workspace.yaml` carries the approvals in `allowBuilds` (esbuild, koffi, node-pty and `@deepseek-ai/dsh-subprocess-local` run; `@google/genai` and `protobufjs` are skipped on purpose), so a plain `pnpm install` works on a fresh clone. If a dependency update adds a new build script, `pnpm install` stops with `ERR_PNPM_IGNORED_BUILDS`. Add that package to `allowBuilds` after reviewing its script.

## Run in development

Start the Gateway from the repository root (it runs `tsx src/main.ts`):

```sh
pnpm --dir apps/gateway start
```

By default it listens on a random loopback port and prints `GATEWAY_READY {"port":N}`. Set `NMH_PORT`, `NMH_DB_PATH` and `NMH_EXTENSIONS_DIR` to control the port, database file and extensions folder. Set `NEO_MODE=desktop` and `NEO_PRINT_DESKTOP_TOKEN=1` to also print the desktop token (`NEO_DESKTOP_TOKEN`). The web UI runs on a separate dev server:

```sh
pnpm --dir apps/neo-app dev      # Vite on 127.0.0.1
```

For the desktop app, build the frontend and run the Tauri shell. `tauri.conf.json` has no dev server URL, so the shell loads `apps/neo-app/dist`. In a checkout, the shell starts its own Gateway from `apps/gateway` (set `NMH_DESKTOP_REPO_ROOT` to use another checkout and `NMH_NODE` for a specific Node binary):

```sh
pnpm --dir apps/neo-app build
cargo run --manifest-path apps/neo-app/src-tauri/Cargo.toml
```

There is no `dev` script for the desktop app in any `package.json`; the commands above come from `tauri.conf.json` and `apps/neo-app/src-tauri/src/lib.rs`.

### Tests and the pinned upstream cache

Some tests start the Gateway with real, pinned engines (Hermes, DeepSeek Harness, dsh-superagent, T3 Code). They read engine source from a local **upstream cache** and fail without it. This includes `pnpm test:toggle` (`tests/toggle-safety/run.mjs`) and `pnpm test:p7-3` (`apps/gateway/test/p7-3.ts`, which enables every extension).

The cache is a folder of read-only, unmodified source clones named `<name>@<ref>`, at the refs pinned in `upstream.lock.json`. Point `NMH_UPSTREAM_CACHE` at it. Hermes and the super agent find an unnamed `nmh-upstream-cache` only inside the checkout (the search stops at the folder holding `.git` or `pnpm-workspace.yaml`), so a cache beside the checkout or its worktrees needs `NMH_UPSTREAM_CACHE`; without it these engines start in install mode, as on an installed app. Tests that need them running therefore stop at once with a message naming `NMH_UPSTREAM_CACHE` when it is unset (`tests/upstream-cache.mjs`). An installed app never searches, so a folder planted above its runtime is never used. `pnpm test:toggle` falls back to a path hard-coded for the maintainer's machine when the variable is unset, so always set `NMH_UPSTREAM_CACHE` explicitly. Populate it once, using the refs in `upstream.lock.json`:

```sh
mkdir nmh-upstream-cache && cd nmh-upstream-cache
git -c core.longpaths=true clone --filter=blob:none https://github.com/deepseek-ai/deepseek-harness.git deepseek-harness@0.2.2-rc.1
git -C deepseek-harness@0.2.2-rc.1 checkout dsh-v0.2.2-rc.1
git -c core.longpaths=true clone --filter=blob:none https://github.com/deepseek-ai/dsh-superagent-prototype.git dsh-superagent@8c32a9dc5d72
git -C dsh-superagent@8c32a9dc5d72 checkout 8c32a9dc5d72
git -c core.longpaths=true clone --filter=blob:none https://github.com/NousResearch/hermes-agent.git hermes-agent@v0.23.2
git -C hermes-agent@v0.23.2 checkout v0.23.2
git -c core.longpaths=true clone --filter=blob:none https://github.com/pingdotgg/t3code.git t3code@v0.1.9
git -C t3code@v0.1.9 checkout v0.1.9
export NMH_UPSTREAM_CACHE="$PWD"
```

Never edit or push from the cache. If `upstream.lock.json` changes, re-clone at the new ref; `pnpm upstream:check` reports drift. The Hermes tests also need `uv` and Python 3.14.

## Desktop installers

The desktop app uses Tauri 2 and the Astryx frontend. Its packaged gateway runs as a local Node sidecar with separately deployed gateway and extension dependencies. The Tauri shell manages the window, tray, and sidecar process. Gateway owns authentication, bots, extensions, and business logic.

Build on the operating system and architecture that will run the installer. Install Node.js 22+, pnpm 12.9.1, Rust 1.90+, and the Tauri 2 CLI (`cargo install tauri-cli --locked`). Windows builds need the Microsoft C++ toolchain, WebView2, and the NSIS or WiX tooling for the selected package. macOS builds need Xcode command-line tools. Linux builds need the Tauri WebKitGTK development dependencies and the system AppImage/deb packaging tools.

From the repository root:

```sh
pnpm install
pnpm installer:check
pnpm --dir apps/neo-app build
```

`installer:prepare` deploys the Gateway and each packaged extension using pnpm, then copies the host Node executable to the architecture-suffixed Tauri sidecar path. It then packs the payload into one uncompressed tar (`installer-runtime/runtime.tar`, pax format, links followed) with a `runtime.json` manifest holding the app version and the archive's sha256. Installers bundle only that directory, so they carry one runtime file instead of ~100k loose ones. Generated files live under `apps/neo-app/src-tauri/installer-payload/`, `apps/neo-app/src-tauri/installer-runtime/` and `apps/neo-app/src-tauri/binaries/`. All are ignored by Git.

On first launch (and after each update) the shell unpacks the archive into `<local app data>/runtime/<version>-<sha12>/`, outside the read-only install directory, before starting the Gateway. It checks the sha256, refuses entries that would land outside that directory, writes a completion marker last and renames the finished directory into place. A lock file serialises concurrent app instances, and older runtime directories are removed afterwards. `NMH_RUNTIME_DIR` overrides the parent directory for tests. Without a bundled archive (development), the shell uses the repository paths. Node license text is included with the runtime (set `NMH_NODE_LICENSE` if using a nonstandard Node distribution). Re-run preparation on each target platform, especially when native Node dependencies are involved.

`installer:prepare` also stages [uv](https://github.com/astral-sh/uv) next to the Gateway sidecar (Tauri `externalBin` `binaries/uv`). The version and the sha256 of each platform's release archive are pinned in `scripts/installer-tools.json`, and a download that does not match is refused. `NMH_UV_ARCHIVE` points at an already downloaded archive for offline builds; it is checked the same way.

Installers do not ship engine sources. **Hermes is installed from the app** (task P7-16): **Extensions** and onboarding's bot step offer **Install Hermes**. The Gateway downloads the GitHub tarball of the commit pinned in `upstream.lock.json` (never the movable tag), checks its sha256 and commit against the lock, and unpacks it into `<local app data>/engines/hermes-agent@<ref>/`. The shell passes that folder as `NMH_ENGINES_DIR` (default `<local app data>/engines`, or `<NMH_DESKTOP_DATA_DIR>/engines` for isolated runs). It then builds the Hermes venv there with the bundled uv and uv-managed Python only (`engines/venvs/`; uv's cache and Python live in `engines/` too), and restarts engine-hermes and channels. A venv whose Python no longer runs is offered for install again and rebuilt. The download and uv honour `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` and `SSL_CERT_FILE`. The Hermes home moves to `<app data>/extensions/engine-hermes/home`, so updates keep bots. uv is found as `NMH_UV`, then next to the Gateway executable, then on `PATH`. In a checkout the development upstream cache (below) is still used first.

**The super agent is installed the same way** from its **Extensions** card (**Install the super agent**). The pinned dsh-superagent tarball (about 1 MB) is verified the same way and unpacked into `<local app data>/engines/dsh-superagent@<ref>/`. The Gateway then bundles the upstream modules it uses with esbuild (which ships in the runtime, as do the DSH packages its worker uses) into the extension's `.cache` folder in the unpacked runtime, and restarts engine-superagent. No Python is involved. The super agent starts without Hermes, but it hands each ticket to a Hermes bot, so until Hermes runs its tickets end as blocked. While its install is offered, its card says so from the Hermes row in Extensions: **Turn on Hermes in Extensions** when Hermes is off, **Hermes needs attention** with Hermes's reason when it could not start, and **Install Hermes first** when Hermes is not installed. Until the super agent is installed, the Inbox offers the same install and keeps Ask disabled, and the Gateway answers Inbox calls with "The super agent is not installed". The bundle is built once and reused while it matches the installed source; if it cannot be built (for example security software holding esbuild), the card shows the reason with **Try again**.

**T3 is installed from its Extensions card** (**Install T3**). The Gateway downloads the official CLI archive for the pinned version and platform, checks its SHA-256 against `upstream.lock.json`, and starts it in the background on loopback. T3 and its provider homes are isolated under `NMH_ENGINES_DIR/t3-home`. To connect to an existing server, set its URL and scoped session in **Settings**. Remote URLs require HTTPS. Coding becomes available when T3 connects, and the Extensions card shows the reason while it is disconnected.

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

The owner's updater public key is **checked in** to `apps/neo-app/src-tauri/tauri.conf.json` under `plugins.updater.pubkey`. It is a public key, so committing it is safe. The checked-in key has key ID `F0BDD994DDA35AF6`.

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

Building signed updater artifacts, generating `latest.json` and publishing a release are covered by the release runbook, [Releasing](release.md).

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
