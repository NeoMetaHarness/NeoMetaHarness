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
