# Releasing Neo Meta Harness

How the owner cuts a release on their own machines. There are **no GitHub Actions**: everything is built,
signed and checked locally, and published with one `gh release create`. Commands are PowerShell
(Windows PowerShell 5.1, or `pwsh` 7 on macOS and Linux) and run from the repository root unless a step says otherwise.

## Rules

- **Full releases only.** Never mark a release as a pre-release or a draft. The desktop updater reads
  `https://github.com/NeoMetaHarness/NeoMetaHarness/releases/latest/download/latest.json`, and GitHub's
  "latest" skips pre-releases and drafts. Versions are plain `X.Y.Z`.
- **Never delete or edit an old release or its assets.** Each `latest.json` points at its own versioned
  asset URLs. To undo a release, publish a newer patch ([Roll back](#roll-back)).
- **The private signing key never leaves `%USERPROFILE%\.tauri\neo-updater.key`.** Nothing in this runbook
  opens it. Tauri reads it during the build through `TAURI_SIGNING_PRIVATE_KEY`. Only the public key
  (`neo-updater.key.pub`) is read, and it goes into a temporary config file outside the repository.
  Never commit either file, a password or a `latest.json`.
- **At most 20 GitHub writes per release** ([GitHub safety guardrails](policies/GITHUB-SAFETY-GUARDRAILS.md)).
  A release normally takes 9: one push and one `gh release create` (1 release plus 1 upload per asset).
  Stop on any 403 or 429.

## 1. Prepare

```powershell
git switch main
git pull --ff-only
git status --short          # must print nothing
$v = '1.0.0'                # the new version: X.Y.Z, higher than the last release
```

## 2. Bump the version everywhere

The shipped version lives in four files, and they must agree:

| File | Field |
|---|---|
| `apps/neo-app/src-tauri/tauri.conf.json` | `"version"` (the version the app and updater report) |
| `apps/neo-app/src-tauri/Cargo.toml` | `[package] version` |
| `apps/neo-app/src-tauri/Cargo.lock` | the `neo-meta-harness` entry (refreshed by Cargo) |
| `apps/neo-app/package.json` | `"version"` |

```powershell
function Set-FirstMatch($path, $pattern, $replacement) {
  $full = (Resolve-Path $path).Path
  $text = [IO.File]::ReadAllText($full)
  $next = ([regex]$pattern).Replace($text, $replacement, 1)
  if ($next -eq $text) { throw "No version found in $path" }
  [IO.File]::WriteAllText($full, $next)    # UTF-8 without BOM
}
Set-FirstMatch apps/neo-app/src-tauri/tauri.conf.json '"version": "[^"]+"' "`"version`": `"$v`""
Set-FirstMatch apps/neo-app/package.json '"version": "[^"]+"' "`"version`": `"$v`""
Set-FirstMatch apps/neo-app/src-tauri/Cargo.toml '(?m)^version = "[^"]+"' "version = `"$v`""
Push-Location apps/neo-app/src-tauri; cargo metadata --format-version 1 --offline > $null; Pop-Location   # refreshes Cargo.lock
git diff --stat             # exactly the four files
```

Then edit [CHANGELOG.md](../CHANGELOG.md):

- Add a `## [X.Y.Z] - YYYY-MM-DD` section, or set the date on an existing `Unreleased` heading.
- Keep it factual: list what is `done` in `machine/readiness.json`.

That section becomes the release notes in `latest.json`.

```powershell
git add apps/neo-app/src-tauri/tauri.conf.json apps/neo-app/src-tauri/Cargo.toml apps/neo-app/src-tauri/Cargo.lock apps/neo-app/package.json CHANGELOG.md
git commit -m "chore(release): v$v"
```

## 3. Release override and preflight

The release build needs two settings that the repository deliberately leaves out: the owner's public key,
and `createUpdaterArtifacts`, which makes Tauri write the `.sig` files. Put them in a temporary file outside
the repository:

```powershell
$pub = (Get-Content "$env:USERPROFILE\.tauri\neo-updater.key.pub" -Raw).Trim()   # the PUBLIC key only
$override = Join-Path $env:TEMP 'neo-release.json'
[IO.File]::WriteAllText($override, (@{
  bundle  = @{ createUpdaterArtifacts = $true }
  plugins = @{ updater = @{ pubkey = $pub } }
} | ConvertTo-Json -Depth 5))

node scripts/release-preflight.mjs --version $v --config $override
```

The preflight only reports; it never changes anything. Every line must say `PASS`:

| Check | What it verifies |
|---|---|
| `version` | `$v` is `X.Y.Z` and all four version files carry it |
| `updater config` | the effective public key is a real minisign key (not the placeholder) and the endpoint is the release URL above |
| `updater artifacts` | `createUpdaterArtifacts` is on in the effective config |
| `working tree` | `git status` is clean |
| `pnpm check` | the local check pipeline passes |
| `changelog` | `CHANGELOG.md` has a non-empty section for `$v` |

Fix anything that fails, commit, and run it again.

## 4. Build and sign each platform

Build on each operating system you release for, from the release commit. See
[Installers & Packaging](install.md) for the toolchain. On each build machine, create the same
`neo-release.json` override (step 3) and point Tauri at the private key **by path**:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "$env:USERPROFILE\.tauri\neo-updater.key"   # a path; Tauri reads the file
$secure = Read-Host 'Updater key password' -AsSecureString
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Net.NetworkCredential]::new('', $secure).Password

Push-Location apps/neo-app/src-tauri
cargo tauri build --config tauri.bundle.conf.json --config $override --bundles nsis,msi     # Windows
# cargo tauri build --config tauri.bundle.conf.json --config $override --bundles app,dmg    # macOS
# cargo tauri build --config tauri.bundle.conf.json --config $override --bundles appimage,deb  # Linux
Pop-Location

Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

Each updater artifact gets a `.sig` file next to it under `apps/neo-app/src-tauri/target/release/bundle/`:

| Platform key | Updater artifact (and its `.sig`) |
|---|---|
| `windows-x86_64-nsis` | `nsis/Neo Meta Harness_X.Y.Z_x64-setup.exe` |
| `windows-x86_64-msi` | `msi/Neo Meta Harness_X.Y.Z_x64_en-US.msi` |
| `darwin-aarch64-app` (or `darwin-x86_64-app`) | `macos/Neo Meta Harness.app.tar.gz` |
| `linux-x86_64-appimage` | `appimage/neo-meta-harness_X.Y.Z_amd64.AppImage` |

The `.dmg` and `.deb` are for manual installs, not updates. Publish them as plain assets.

Copy every artifact, together with its `.sig`, to the machine that publishes the release.

- A platform you skip gets no update from this release.
- Users on that platform keep checking `latest.json` and find no entry for them.

## 5. Generate latest.json

```powershell
$bundle = 'apps/neo-app/src-tauri/target/release/bundle'
node scripts/release-manifest.mjs --version $v --out-dir release-out `
  --pubkey-file "$env:USERPROFILE\.tauri\neo-updater.key.pub" `
  --artifact "windows-x86_64-nsis=$bundle/nsis/Neo Meta Harness_${v}_x64-setup.exe" `
  --artifact "windows-x86_64-msi=$bundle/msi/Neo Meta Harness_${v}_x64_en-US.msi" `
  --artifact "darwin-aarch64-app=C:/release-inputs/Neo Meta Harness.app.tar.gz" `
  --artifact "linux-x86_64-appimage=C:/release-inputs/neo-meta-harness_${v}_amd64.AppImage"
```

The script writes `release-out/latest.json` and copies each artifact into `release-out/`, named as GitHub
will serve it (spaces become dots). For each platform, `latest.json` holds:

- `version`, `notes` (the CHANGELOG section) and `pub_date`;
- a `url` under `https://github.com/NeoMetaHarness/NeoMetaHarness/releases/download/vX.Y.Z/`;
- a `signature`, copied from the `.sig` file.

It also adds a plain `<os>-<arch>` entry for each platform.

It refuses to write anything when:

- a `.sig` is missing, malformed, signs a different file, or was made with a key other than `--pubkey-file`;
- an artifact is missing, has the wrong type for its platform key, or was built for another version;
- the version is not `X.Y.Z`, or it differs from any of the four version files;
- a URL is not HTTPS;
- the CHANGELOG has no entry for the version;
- `release-out` is not empty.

`release-out/` is outside version control: never commit it.

```powershell
Get-Content release-out/latest.json      # check version, notes and one entry per platform
```

## 6. Publish (the owner runs this; one push, one release)

This is the only step that writes to GitHub. Count the writes: the push is 1, and `gh release create` is
1 plus 1 per asset. Six assets makes 8 writes, 9 in total.

```powershell
git push origin main                                     # write 1: the release commit
$sha = git rev-parse HEAD
gh release create "v$v" --latest --target $sha --title "Neo Meta Harness v$v" `
  --notes-file (Join-Path $env:TEMP "neo-notes-$v.md") `
  release-out/latest.json release-out/*.exe release-out/*.msi release-out/*.tar.gz release-out/*.AppImage `
  "C:/release-inputs/Neo Meta Harness_${v}_aarch64.dmg"   # writes 2..9: the release and its assets
```

Write the notes file first: copy the CHANGELOG section into `$env:TEMP\neo-notes-$v.md`.

- `--latest` marks the release as the one `releases/latest` serves.
- Never add `--prerelease` or `--draft`.
- `gh` creates the `vX.Y.Z` tag on `$sha`; there is no separate tag push.

Then check it with reads only:

```powershell
gh release view "v$v"
Invoke-RestMethod https://github.com/NeoMetaHarness/NeoMetaHarness/releases/latest/download/latest.json |
  Select-Object version, pub_date
```

The version must be `$v`.

## 7. Verify the update in the installed app

1. On a test machine, install the **previous** release's installer and open Neo Meta Harness.
2. Open **Settings** and check for updates.
3. The app must report version `X.Y.Z`. If it doesn't, check that `latest.json` has an entry for this
   machine's platform, and that the release is marked latest.
4. When the update is installed (the signed install flow is task P1-11), the app restarts on `X.Y.Z` and the
   Gateway sidecar comes back. A signature mismatch is refused, so a failure here means the artifact and its
   `.sig` don't match the published key.

## Roll back

Tauri updates only to a **higher** version, so a bad release is replaced, never removed:

1. Leave the bad release and its assets in place.
2. Revert the faulty change on `main` (`git revert <sha>`).
3. Release the next patch version (`X.Y.Z+1`) with steps 1–7, with a CHANGELOG entry that says what it
   rolls back.

`releases/latest` then points at the fix, and installed copies of the bad version update to it.
