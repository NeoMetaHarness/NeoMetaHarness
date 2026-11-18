# Encrypted backup and restore

Enable the `backup` extension. Backups contain a `VACUUM INTO` SQLite snapshot
(including encrypted vault records), extension storage, registry Git history,
superagent traces, DSH homes, and the default Neo-owned Hermes home. Neo only
connects to externally hosted T3; it does not own or archive that server's home.
Explicit external Hermes homes are also outside the inventory. Personal engine
homes are never discovered or traversed. Caches, dependencies, lock files,
auth signing secrets and desktop tokens are excluded. Restored sessions use new
local authentication secrets; sign in again on remote clients.

The vault master key is **not in the archive**. Keep the original
`vault-keys/master.key` separately in secure storage. Losing that key makes
restored vault secrets unrecoverable. The archive passphrase is a separate secret;
it cannot replace the vault key. Custom vault key paths are excluded explicitly.

From the repository root, set `NEO_GATEWAY_URL` to the running Gateway and
`NEO_GATEWAY_TOKEN` to an owner token. Supply the archive passphrase (at least 12
characters) on stdin or through `NEO_BACKUP_PASSPHRASE_FILE`, a private UTF-8 file.
Do not put secrets in command arguments. Output paths are on the Gateway host.

```text
pnpm neo:backup --out C:/backups/neo.neo
```

The archive uses AES-256-GCM with a random salt and nonce, scrypt (N=32768,
r=8, p=1) for key derivation, and an authenticated format header. Inside is a
compressed manifest with format/product/extension/upstream versions and SHA-256
and size for each file. Files are bounded to 256 MiB in total; this first format
builds the archive in memory. Existing output files are never overwritten.
Symbolic links and special files are rejected.

Pause engine jobs and registry edits before backing up for an application-wide
consistent recovery point. SQLite itself is always a consistent online snapshot;
extension files changing while read cause failure. Filesystem and SQLite writes
are not a single distributed transaction.

SQLite files in engine homes are also snapshotted with `VACUUM INTO`; WAL/SHM
files are excluded. Inbox records are persisted by the Neo superagent adapter.
On restart, unfinished Inbox items become blocked with a resubmit instruction:
upstream in-memory tickets cannot resume. Completed reports remain available.

Restore works offline, without a running Gateway (and therefore without a token):

```text
pnpm neo:restore --archive C:/backups/neo.neo --data-dir C:/Neo-restored
```

Use the same stdin/passphrase-file mechanism. Authentication, decompression,
format/product version, path safety, file sizes, hashes and SQLite integrity are
verified before the destination is published. Unknown archive/product versions
are rejected. The original extension and upstream versions are recorded in
`backup-manifest.json`; install compatible extension versions before booting.
Non-empty directories are refused unless `--force` explicitly requests replacement.
The owner-only `system.restore` route offers the same operation but refuses paths
overlapping live Gateway storage or installed extensions. It never replaces the
running Gateway. Links in destination ancestors are refused.

Put the separately retained vault key in `C:/Neo-restored/vault-keys/master.key`
using the vault's private-file permissions before first boot, or configure
`vaultKeyFile`/the key provider to point to the original secure key. Boot with
`NMH_DB_PATH=C:/Neo-restored/neo.sqlite`. Do not boot without the original key:
a newly generated key cannot decrypt archived secrets. The restored Neo Hermes
home is selected from extension storage; external Hermes/T3 locations are untouched.
