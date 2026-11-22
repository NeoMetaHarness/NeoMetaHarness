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
- **The private signing key and its password stay with the owner.** Nothing in this runbook names, reads or
  copies them. The owner puts them in `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
  for the build shell from their own shell or secret store ([step 4](#4-build-and-sign-each-platform)).
- **The public key is the one checked in** to `apps/neo-app/src-tauri/tauri.conf.json`
  (`plugins.updater.pubkey`). The release tooling reads only that key: the preflight refuses the placeholder
  and any override that changes it, and `release-manifest.mjs` verifies every signature with it. Setting the
  real key there is task P1-11; no release can be cut until it is merged.
- Never commit a private key, a password or a `latest.json`.
- **At most 20 GitHub writes per release** ([GitHub safety guardrails](policies/GITHUB-SAFETY-GUARDRAILS.md)).
  A release normally takes 9: one push and one `gh release create` (1 release plus 1 upload per asset, for
  7 assets). Stop on any 403 or 429.

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

The release build needs one setting that the repository deliberately leaves off: `createUpdaterArtifacts`,
which makes Tauri write the `.sig` files. Put it in a temporary file outside the repository. The override
holds nothing else; the public key always comes from the checked-in `tauri.conf.json`.

```powershell
$override = Join-Path ([IO.Path]::GetTempPath()) 'neo-release.json'   # works on Windows, macOS and Linux
[IO.File]::WriteAllText($override, (@{ bundle = @{ createUpdaterArtifacts = $true } } | ConvertTo-Json -Depth 5))

node scripts/release-preflight.mjs --version $v --config $override
```

The preflight only reports; it never changes anything. Every line must say `PASS`:

| Check | What it verifies |
|---|---|
| `version` | `$v` is `X.Y.Z` and all four version files carry it |
| `updater config` | first, the public key checked in to `tauri.conf.json` is a real minisign key (not the placeholder); then, in the effective config (`tauri.conf.json`, `tauri.bundle.conf.json`, every `--config` and `TAURI_CONFIG`), the key is still that checked-in key, the endpoint is the release URL above and the version is `$v` |
| `updater artifacts` | `createUpdaterArtifacts` is on in the effective config |
| `working tree` | `git status` is clean |
| `pnpm check` | the local check pipeline passes |
| `changelog` | `CHANGELOG.md` has a non-empty section for `$v` |

Fix anything that fails, commit, and run it again.

## 4. Build and sign each platform

Build on each operating system you release for, from the release commit. See
[Installers & Packaging](install.md) for the toolchain. On each build machine, create the same
`neo-release.json` override (step 3).

Before building, set both signing variables **in the build shell only**, from your own shell or secret
store. This runbook does not say where the key is kept, and nothing here reads it:

- `TAURI_SIGNING_PRIVATE_KEY`: the private key (its contents or its path, as the Tauri CLI accepts).
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password.

Don't write either value to a file in the repository, a profile script or the shell history.

```powershell
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

The macOS archive's name has no version. `release-manifest.mjs` reads the version from the bundle's
`Info.plist` (`CFBundleShortVersionString`) inside the signed archive, so an older archive with a valid
signature is refused.

The `.dmg` (`dmg/Neo Meta Harness_X.Y.Z_aarch64.dmg`) and `.deb` (`deb/neo-meta-harness_X.Y.Z_amd64.deb`) are
for manual installs, not updates. Publish them as plain assets.

Copy every artifact, together with its `.sig`, to the machine that publishes the release.

- A platform you skip gets no update from this release.
- Users on that platform keep checking `latest.json` and find no entry for them.

## 5. Generate latest.json

```powershell
$bundle = 'apps/neo-app/src-tauri/target/release/bundle'
node scripts/release-manifest.mjs --version $v --out-dir release-out `
  --artifact "windows-x86_64-nsis=$bundle/nsis/Neo Meta Harness_${v}_x64-setup.exe" `
  --artifact "windows-x86_64-msi=$bundle/msi/Neo Meta Harness_${v}_x64_en-US.msi" `
  --artifact "darwin-aarch64-app=C:/release-inputs/Neo Meta Harness.app.tar.gz" `
  --artifact "linux-x86_64-appimage=C:/release-inputs/neo-meta-harness_${v}_amd64.AppImage"
```

The script writes `release-out/latest.json` and copies each artifact into `release-out/`, named as GitHub
will serve it (spaces become dots). For each platform, `latest.json` holds:

- `version`, `notes` and `pub_date`. The notes are the CHANGELOG section for `$v` and nothing else; there
  is no option to take them from another file;
- a `url` under `https://github.com/NeoMetaHarness/NeoMetaHarness/releases/download/vX.Y.Z/`;
- a `signature`, copied from the `.sig` file.

It also adds a plain `<os>-<arch>` entry for each platform.

It refuses to write anything when:

- the public key checked in to `tauri.conf.json` is missing or still the placeholder;
- a `.sig` is missing or malformed, does not verify against the artifact's bytes with that key, or names a
  different file in its signed trusted comment;
- an artifact is missing, or has the wrong type for its platform key;
- an artifact was built for another version: from its file name or, for the macOS `.app.tar.gz`, from its
  `Info.plist`;
- the CHANGELOG section looks like it contains key material;
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
1 plus 1 per asset. The 7 assets are `latest.json`, the four updater artifacts, the `.dmg` and the `.deb`:
8 writes for the release, 9 in total.

```powershell
# The release page notes are the same CHANGELOG section as latest.json (no GitHub write).
$notes = Join-Path ([IO.Path]::GetTempPath()) "neo-notes-$v.md"
[IO.File]::WriteAllText($notes, (Get-Content release-out/latest.json -Raw | ConvertFrom-Json).notes)

git push origin main                                     # write 1: the release commit
$sha = git rev-parse HEAD
gh release create "v$v" --latest --target $sha --title "Neo Meta Harness v$v" --notes-file $notes `
  release-out/latest.json release-out/*.exe release-out/*.msi release-out/*.tar.gz release-out/*.AppImage `
  "C:/release-inputs/Neo Meta Harness_${v}_aarch64.dmg" `
  "C:/release-inputs/neo-meta-harness_${v}_amd64.deb"     # writes 2..9: the release and its 7 assets
```

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

The desktop app reads its updater endpoint and public key from two environment variables at run time:
`NMH_UPDATER_ENDPOINT` and `NMH_UPDATER_PUBLIC_KEY`. Without them, **Settings** reports "Updater endpoint is
not configured" even on a correct install. Set both in a shell and start the app from that shell, so the
app inherits them.

**Check-only smoke test** (works today):

1. On a test machine, install the **previous** release's installer. Don't open the app yet.
2. In a PowerShell window on that machine, from a checkout of the release commit:

   ```powershell
   $env:NMH_UPDATER_ENDPOINT = 'https://github.com/NeoMetaHarness/NeoMetaHarness/releases/latest/download/latest.json'
   $env:NMH_UPDATER_PUBLIC_KEY = (Get-Content apps/neo-app/src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).plugins.updater.pubkey
   ```

   This is the public key only, the one checked in.
3. Start the installed app from the same shell by its executable, not from a shortcut or Finder, which
   don't pass the variables on. The executable is `neo-meta-harness` (`neo-meta-harness.exe` on Windows),
   inside the install folder. On macOS it is
   `/Applications/Neo Meta Harness.app/Contents/MacOS/neo-meta-harness`. On Linux, run the AppImage.
4. Open **Settings** and check for updates. The app must report version `X.Y.Z`.
5. If it doesn't, check that `latest.json` has an entry for this machine's platform, and that the release
   is marked latest.

**Signed install and restart** applies only once task P1-11 (the signed desktop update flow) is merged.
Check that P1-11 is `done` in `machine/readiness.json` first. On `main` before then, the app only checks
and reports the version, so stop after the smoke test. Once P1-11 is merged:

1. Install the update from **Settings**.
2. The app must restart on `X.Y.Z`, and the Gateway sidecar must come back.
3. A signature mismatch is refused. A failure here means the artifact and its `.sig` don't match the
   published key.

If P1-11 changes how the app gets its endpoint or key, follow its documentation instead of the variables
above.

## Roll back

Tauri updates only to a **higher** version, so a bad release is replaced, never removed:

1. Leave the bad release and its assets in place.
2. Revert the faulty change on `main` (`git revert <sha>`).
3. Release the next patch version (`X.Y.Z+1`) with steps 1–7, with a CHANGELOG entry that says what it
   rolls back.

`releases/latest` then points at the fix, and installed copies of the bad version update to it.
