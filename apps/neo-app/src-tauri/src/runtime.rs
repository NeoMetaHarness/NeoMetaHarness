//! Unpacks the bundled Gateway runtime archive on first launch (an OS concern: files on disk).
//!
//! Installers ship one `runtime/runtime.tar` plus `runtime/runtime.json` ({version, sha256}) as Tauri
//! resources. The shell extracts it once into `<base>/<version>-<sha12>`, where `<base>` is
//! `<app_local_data_dir>/runtime` (or `NMH_RUNTIME_DIR`). The install directory itself stays read-only.
//!
//! Protocol, all under an exclusive OS lock on `<base>/.lock` (released by the OS if the process dies):
//! 1. If `<target>/.nmh-runtime-complete` holds the expected sha256, reuse `<target>`.
//! 2. Otherwise remove any `<target>` / leftover `<base>/.tmp-<key>`, extract into the temp dir while hashing the
//!    archive, refuse unsafe entries (anything but files, directories and hard links inside the runtime, or any
//!    path leaving it), check the hash, write the marker last, then rename the temp dir to `<target>`.
//! 3. Remove other entries under `<base>` (older versions, stale temp dirs) best-effort.

use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::thread;
use std::time::Duration;

pub const ARCHIVE_NAME: &str = "runtime.tar";
pub const MANIFEST_NAME: &str = "runtime.json";
pub const MARKER_NAME: &str = ".nmh-runtime-complete";
const LOCK_NAME: &str = ".lock";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeManifest {
    pub version: String,
    pub sha256: String,
}

impl RuntimeManifest {
    pub fn parse(text: &str) -> Result<Self, String> {
        let value: serde_json::Value =
            serde_json::from_str(text).map_err(|error| format!("Runtime manifest is not valid JSON: {error}"))?;
        let version = value["version"].as_str().unwrap_or_default().to_string();
        let sha256 = value["sha256"].as_str().unwrap_or_default().to_ascii_lowercase();
        let safe_version = !version.is_empty()
            && version.len() <= 64
            && version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+' | '_'));
        if !safe_version {
            return Err(format!("Runtime manifest has an invalid version: {version:?}"));
        }
        if sha256.len() != 64 || !sha256.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("Runtime manifest has an invalid sha256".into());
        }
        Ok(Self { version, sha256 })
    }

    /// Short directory name: keeps unpacked node_modules paths well below Windows limits.
    pub fn key(&self) -> String {
        format!("{}-{}", self.version, &self.sha256[..12])
    }

    fn marker(&self) -> String {
        format!("{}\n{}\n", self.version, self.sha256)
    }
}

/// The archive bundled with an installed app, if any. `None` means development mode (no archive in resources).
pub fn bundled_archive(resource_runtime_dir: &Path) -> Result<Option<(PathBuf, RuntimeManifest)>, String> {
    let archive = resource_runtime_dir.join(ARCHIVE_NAME);
    let manifest = resource_runtime_dir.join(MANIFEST_NAME);
    if !archive.is_file() && !manifest.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(&manifest)
        .map_err(|error| format!("Bundled runtime manifest {} unreadable: {error}", manifest.display()))?;
    if !archive.is_file() {
        return Err(format!("Bundled runtime archive {} is missing", archive.display()));
    }
    Ok(Some((archive, RuntimeManifest::parse(&text)?)))
}

fn is_complete(target: &Path, manifest: &RuntimeManifest) -> bool {
    fs::read_to_string(target.join(MARKER_NAME)).is_ok_and(|text| text == manifest.marker())
}

fn remove_dir_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot remove {}: {error}", path.display())),
    }
}

/// Rejects anything that is not a plain relative path inside the archive root.
fn safe_relative_path(path: &Path) -> Result<PathBuf, String> {
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            _ => return Err(format!("Runtime archive entry {} escapes the runtime directory", path.display())),
        }
    }
    Ok(clean)
}

struct HashingReader<R> {
    inner: R,
    hasher: Sha256,
}

impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let count = self.inner.read(buf)?;
        self.hasher.update(&buf[..count]);
        Ok(count)
    }
}

/// Recreates a hard link to a file extracted earlier. Falls back to a copy when the file system refuses the link
/// (e.g. NTFS's 1024-links-per-file limit, or a volume without hard links).
fn link_or_copy(source: &Path, target: &Path) -> io::Result<()> {
    // Only plain files that this extraction created: the archive holds no symlinks, and every path is relative.
    if !fs::symlink_metadata(source)?.is_file() {
        return Err(io::Error::other(format!("hard link source {} is not a file", source.display())));
    }
    if fs::symlink_metadata(target).is_ok() {
        return Err(io::Error::other(format!("{} already exists", target.display())));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::hard_link(source, target).is_err() {
        fs::copy(source, target)?;
    }
    Ok(())
}

fn extract(archive: &Path, destination: &Path, expected_sha256: &str) -> Result<(), String> {
    let file = File::open(archive).map_err(|error| format!("Cannot open runtime archive {}: {error}", archive.display()))?;
    let reader = HashingReader { inner: io::BufReader::with_capacity(1 << 20, file), hasher: Sha256::new() };
    let mut tar = tar::Archive::new(reader);
    tar.set_preserve_permissions(cfg!(unix));
    tar.set_overwrite(false);
    fs::create_dir_all(destination).map_err(|error| format!("Cannot create {}: {error}", destination.display()))?;
    let fail = |error: io::Error| format!("Runtime archive {} is unreadable: {error}", archive.display());
    for entry in tar.entries().map_err(fail)? {
        let mut entry = entry.map_err(fail)?;
        let path = entry.path().map_err(fail)?.into_owned();
        let relative = safe_relative_path(&path)?;
        match entry.header().entry_type() {
            tar::EntryType::Regular | tar::EntryType::Continuous | tar::EntryType::Directory => {}
            // pnpm's store hard-links identical files; bsdtar records them as hard links within the archive.
            tar::EntryType::Link => {
                let source = entry.link_name().map_err(fail)?.ok_or_else(|| format!("Runtime hard link {} has no source", path.display()))?;
                let source_relative = safe_relative_path(&source)?;
                if source_relative.as_os_str().is_empty() || relative.as_os_str().is_empty() {
                    return Err(format!("Runtime hard link {} is malformed", path.display()));
                }
                link_or_copy(&destination.join(source_relative), &destination.join(&relative))
                    .map_err(|error| format!("Cannot extract runtime hard link {}: {error}", path.display()))?;
                continue;
            }
            other => return Err(format!("Runtime archive entry {} has unsupported type {other:?}", path.display())),
        }
        if relative.as_os_str().is_empty() {
            continue; // the archive root itself ("./")
        }
        let unpacked = entry
            .unpack_in(destination)
            .map_err(|error| format!("Cannot extract runtime entry {}: {error}", path.display()))?;
        if !unpacked {
            return Err(format!("Runtime archive entry {} was refused", path.display()));
        }
    }
    let mut reader = tar.into_inner();
    io::copy(&mut reader, &mut io::sink()).map_err(fail)?;
    let actual: String = reader.hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
    if actual != expected_sha256 {
        return Err(format!("Runtime archive {} is corrupt (sha256 {actual}, expected {expected_sha256})", archive.display()));
    }
    Ok(())
}

fn rename_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    // Virus scanners briefly hold handles on freshly written files on Windows.
    let mut attempt = 0;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) if attempt < 10 => {
                let _ = error;
                attempt += 1;
                thread::sleep(Duration::from_millis(200));
            }
            Err(error) => return Err(error),
        }
    }
}

/// Removes every runtime under `base` except `keep` (older versions, crashed temp dirs). Best-effort: a runtime
/// still in use by another process is left for the next launch.
fn remove_other_runtimes(base: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(base) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name == keep || name == LOCK_NAME {
            continue;
        }
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// Returns the unpacked runtime directory for `manifest`, extracting `archive` first when needed.
pub fn ensure_runtime(archive: &Path, manifest: &RuntimeManifest, base: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(base).map_err(|error| format!("Cannot create runtime directory {}: {error}", base.display()))?;
    let lock_path = base.join(LOCK_NAME);
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)
        .map_err(|error| format!("Cannot open runtime lock {}: {error}", lock_path.display()))?;
    // A second instance waits here until the first has finished; the OS drops the lock if a process dies.
    lock.lock().map_err(|error| format!("Cannot lock runtime directory {}: {error}", base.display()))?;

    let key = manifest.key();
    let target = base.join(&key);
    if !is_complete(&target, manifest) {
        let temp = base.join(format!(".tmp-{key}"));
        remove_dir_if_present(&temp)?;
        remove_dir_if_present(&target)?;
        let result = extract(archive, &temp, &manifest.sha256)
            .and_then(|()| {
                fs::write(temp.join(MARKER_NAME), manifest.marker())
                    .map_err(|error| format!("Cannot write runtime marker: {error}"))
            })
            .and_then(|()| {
                rename_with_retry(&temp, &target)
                    .map_err(|error| format!("Cannot move runtime into {}: {error}", target.display()))
            });
        if let Err(error) = result {
            let _ = fs::remove_dir_all(&temp);
            return Err(error);
        }
    }
    remove_other_runtimes(base, &key);
    drop(lock);
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static NEXT: AtomicU32 = AtomicU32::new(0);

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "nmh-rt-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sha256_of(path: &Path) -> String {
        let bytes = fs::read(path).unwrap();
        Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect()
    }

    /// Builds an archive with the real payload layout and returns its manifest.
    fn payload_archive(dir: &Path, version: &str, body: &str) -> (PathBuf, RuntimeManifest) {
        let archive = dir.join(format!("runtime-{version}-{}.tar", body.len()));
        let mut builder = tar::Builder::new(File::create(&archive).unwrap());
        let mut add = |path: &str, data: &[u8]| {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_entry_type(tar::EntryType::Regular);
            builder.append_data(&mut header, path, data).unwrap();
        };
        add("apps/gateway/src/main.ts", body.as_bytes());
        add("extensions/demo/neo.extension.json", b"{}");
        add("upstream.lock.json", b"{}");
        // Long nested path: exercises GNU/pax long-name records.
        let deep = format!("apps/gateway/node_modules/{}/index.js", "very-long-package-name/".repeat(12));
        add(&deep, b"module.exports = 1;");
        builder.into_inner().unwrap();
        let manifest = RuntimeManifest { version: version.into(), sha256: sha256_of(&archive) };
        (archive, manifest)
    }

    #[test]
    fn fresh_extract_writes_marker_and_layout() {
        let scratch = Scratch::new();
        let (archive, manifest) = payload_archive(&scratch.0, "1.0.0", "console.log(1)");
        let base = scratch.0.join("runtime");
        let target = ensure_runtime(&archive, &manifest, &base).unwrap();
        assert_eq!(target, base.join(manifest.key()));
        assert_eq!(fs::read_to_string(target.join("apps/gateway/src/main.ts")).unwrap(), "console.log(1)");
        assert!(target.join("extensions/demo/neo.extension.json").is_file());
        assert!(is_complete(&target, &manifest));
        assert!(!base.join(format!(".tmp-{}", manifest.key())).exists());
        assert_eq!(manifest.key().len(), "1.0.0-".len() + 12);
    }

    #[test]
    fn already_extracted_runtime_is_reused() {
        let scratch = Scratch::new();
        let (archive, manifest) = payload_archive(&scratch.0, "1.0.0", "original");
        let base = scratch.0.join("runtime");
        let target = ensure_runtime(&archive, &manifest, &base).unwrap();
        // A sentinel survives the second call, and the archive is not even opened again.
        fs::write(target.join("sentinel"), "kept").unwrap();
        fs::remove_file(&archive).unwrap();
        assert_eq!(ensure_runtime(&archive, &manifest, &base).unwrap(), target);
        assert_eq!(fs::read_to_string(target.join("sentinel")).unwrap(), "kept");
    }

    #[test]
    fn leftover_temp_dir_from_crash_is_replaced() {
        let scratch = Scratch::new();
        let (archive, manifest) = payload_archive(&scratch.0, "1.0.0", "fresh");
        let base = scratch.0.join("runtime");
        let temp = base.join(format!(".tmp-{}", manifest.key()));
        fs::create_dir_all(temp.join("apps/gateway/src")).unwrap();
        fs::write(temp.join("apps/gateway/src/main.ts"), "half").unwrap();
        fs::write(temp.join("junk"), "x").unwrap();
        let target = ensure_runtime(&archive, &manifest, &base).unwrap();
        assert_eq!(fs::read_to_string(target.join("apps/gateway/src/main.ts")).unwrap(), "fresh");
        assert!(!target.join("junk").exists());
        assert!(!temp.exists());
    }

    #[test]
    fn missing_or_corrupt_marker_forces_reextract() {
        let scratch = Scratch::new();
        let (archive, manifest) = payload_archive(&scratch.0, "1.0.0", "good");
        let base = scratch.0.join("runtime");
        let target = ensure_runtime(&archive, &manifest, &base).unwrap();
        fs::write(target.join("apps/gateway/src/main.ts"), "tampered").unwrap();
        fs::write(target.join(MARKER_NAME), "garbage").unwrap();
        ensure_runtime(&archive, &manifest, &base).unwrap();
        assert_eq!(fs::read_to_string(target.join("apps/gateway/src/main.ts")).unwrap(), "good");
        fs::remove_file(target.join(MARKER_NAME)).unwrap();
        fs::write(target.join("stray"), "x").unwrap();
        ensure_runtime(&archive, &manifest, &base).unwrap();
        assert!(is_complete(&target, &manifest));
        assert!(!target.join("stray").exists());
    }

    #[test]
    fn version_change_removes_old_runtimes() {
        let scratch = Scratch::new();
        let base = scratch.0.join("runtime");
        let (old_archive, old) = payload_archive(&scratch.0, "1.0.0", "old");
        let old_dir = ensure_runtime(&old_archive, &old, &base).unwrap();
        fs::create_dir_all(base.join(".tmp-0.9.0-deadbeefdead")).unwrap();
        let (new_archive, new) = payload_archive(&scratch.0, "1.1.0", "newer");
        let new_dir = ensure_runtime(&new_archive, &new, &base).unwrap();
        assert!(!old_dir.exists());
        assert!(!base.join(".tmp-0.9.0-deadbeefdead").exists());
        assert_eq!(fs::read_to_string(new_dir.join("apps/gateway/src/main.ts")).unwrap(), "newer");
    }

    fn raw_entry_archive(dir: &Path, name: &[u8], kind: tar::EntryType, link: Option<&[u8]>) -> (PathBuf, RuntimeManifest) {
        let archive = dir.join("evil.tar");
        let mut builder = tar::Builder::new(File::create(&archive).unwrap());
        let mut header = tar::Header::new_old();
        header.as_old_mut().name[..name.len()].copy_from_slice(name);
        if let Some(link) = link {
            header.as_old_mut().linkname[..link.len()].copy_from_slice(link);
        }
        header.set_entry_type(kind);
        header.set_mode(0o644);
        let data: &[u8] = if kind == tar::EntryType::Regular { b"pwned" } else { b"" };
        header.set_size(data.len() as u64);
        header.set_cksum();
        builder.append(&header, data).unwrap();
        builder.into_inner().unwrap();
        let manifest = RuntimeManifest { version: "1.0.0".into(), sha256: sha256_of(&archive) };
        (archive, manifest)
    }

    #[test]
    fn path_traversal_and_links_are_refused() {
        let cases: [(&[u8], tar::EntryType, Option<&[u8]>); 5] = [
            (b"../escape.txt", tar::EntryType::Regular, None),
            (b"apps/../../escape.txt", tar::EntryType::Regular, None),
            (b"/abs/escape.txt", tar::EntryType::Regular, None),
            (b"apps/link", tar::EntryType::Symlink, Some(b"../../outside")),
            (b"apps/hard", tar::EntryType::Link, Some(b"../../outside")),
        ];
        for (name, kind, link) in cases {
            let scratch = Scratch::new();
            let (archive, manifest) = raw_entry_archive(&scratch.0, name, kind, link);
            let base = scratch.0.join("nested").join("runtime");
            let error = ensure_runtime(&archive, &manifest, &base).unwrap_err();
            assert!(error.contains("escapes") || error.contains("unsupported type"), "{error}");
            assert!(!scratch.0.join("escape.txt").exists());
            assert!(!scratch.0.join("nested").join("escape.txt").exists());
            assert!(!base.join(manifest.key()).exists(), "no half-extracted runtime");
            assert!(!base.join(format!(".tmp-{}", manifest.key())).exists(), "temp dir cleaned up");
        }
    }

    #[test]
    fn absolute_paths_beyond_windows_max_path_extract() {
        let scratch = Scratch::new();
        let (archive, manifest) = payload_archive(&scratch.0, "1.0.0", "deep");
        // A deep base on top of the 290-character entry: well past MAX_PATH (260) as an absolute path.
        let base = scratch.0.join("a-fairly-long-user-profile-directory-name").join("runtime");
        let target = ensure_runtime(&archive, &manifest, &base).unwrap();
        let deep = target.join(format!("apps/gateway/node_modules/{}/index.js", "very-long-package-name/".repeat(12)));
        assert!(deep.as_os_str().len() > 300, "{}", deep.as_os_str().len());
        assert_eq!(fs::read_to_string(&deep).unwrap(), "module.exports = 1;");
        // Cleanup of an old runtime with such paths also works.
        let (newer, newer_manifest) = payload_archive(&scratch.0, "1.0.1", "deeper");
        ensure_runtime(&newer, &newer_manifest, &base).unwrap();
        assert!(!target.exists());
    }

    /// Opt-in check against the real installer archive:
    /// `NMH_RUNTIME_ARCHIVE_TEST=<src-tauri>/installer-runtime cargo test -- --ignored real_archive`.
    #[test]
    #[ignore]
    fn real_archive_extracts() {
        let dir = PathBuf::from(std::env::var_os("NMH_RUNTIME_ARCHIVE_TEST").expect("NMH_RUNTIME_ARCHIVE_TEST"));
        let (archive, manifest) = bundled_archive(&dir).unwrap().expect("runtime.tar and runtime.json");
        let scratch = Scratch::new();
        let started = std::time::Instant::now();
        let target = ensure_runtime(&archive, &manifest, &scratch.0.join("runtime")).unwrap();
        eprintln!("extracted {} in {:?}", target.display(), started.elapsed());
        assert!(target.join("apps/gateway/src/main.ts").is_file());
        assert!(target.join("upstream.lock.json").is_file());
        let started = std::time::Instant::now();
        assert_eq!(ensure_runtime(&archive, &manifest, &scratch.0.join("runtime")).unwrap(), target);
        eprintln!("reused in {:?}", started.elapsed());
    }

    #[test]
    fn hard_links_inside_the_runtime_are_restored() {
        let scratch = Scratch::new();
        let archive = scratch.0.join("links.tar");
        let mut builder = tar::Builder::new(File::create(&archive).unwrap());
        let mut header = tar::Header::new_gnu();
        header.set_size(5);
        header.set_mode(0o644);
        builder.append_data(&mut header, "./apps/gateway/src/main.ts", &b"same!"[..]).unwrap();
        let mut link = tar::Header::new_gnu();
        link.set_entry_type(tar::EntryType::Link);
        link.set_size(0);
        builder.append_link(&mut link, "./apps/gateway/src/copy.ts", "./apps/gateway/src/main.ts").unwrap();
        builder.into_inner().unwrap();
        let manifest = RuntimeManifest { version: "1.0.0".into(), sha256: sha256_of(&archive) };
        let target = ensure_runtime(&archive, &manifest, &scratch.0.join("runtime")).unwrap();
        assert_eq!(fs::read_to_string(target.join("apps/gateway/src/copy.ts")).unwrap(), "same!");
    }

    #[test]
    fn corrupt_archive_hash_is_refused() {
        let scratch = Scratch::new();
        let (archive, mut manifest) = payload_archive(&scratch.0, "1.0.0", "body");
        manifest.sha256 = "0".repeat(64);
        let base = scratch.0.join("runtime");
        let error = ensure_runtime(&archive, &manifest, &base).unwrap_err();
        assert!(error.contains("corrupt"), "{error}");
        assert!(!base.join(manifest.key()).exists());
    }

    #[test]
    fn concurrent_instances_share_one_runtime() {
        let scratch = Scratch::new();
        let (archive, manifest) = payload_archive(&scratch.0, "1.0.0", "shared");
        let base = scratch.0.join("runtime");
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let (archive, manifest, base) = (archive.clone(), manifest.clone(), base.clone());
                thread::spawn(move || ensure_runtime(&archive, &manifest, &base))
            })
            .collect();
        for handle in handles {
            let target = handle.join().unwrap().unwrap();
            assert_eq!(fs::read_to_string(target.join("apps/gateway/src/main.ts")).unwrap(), "shared");
        }
    }

    #[test]
    fn bundled_archive_detection() {
        let scratch = Scratch::new();
        assert_eq!(bundled_archive(&scratch.0.join("absent")).unwrap(), None, "development mode");
        fs::write(scratch.0.join(MANIFEST_NAME), r#"{"version":"1.0.0","sha256":"ab"}"#).unwrap();
        assert!(bundled_archive(&scratch.0).is_err(), "manifest without archive is an error");
        fs::write(scratch.0.join(ARCHIVE_NAME), b"").unwrap();
        assert!(bundled_archive(&scratch.0).unwrap_err().contains("sha256"));
        let sha = "a".repeat(64);
        fs::write(scratch.0.join(MANIFEST_NAME), format!(r#"{{"version":"1.0.0","sha256":"{sha}"}}"#)).unwrap();
        let (_, manifest) = bundled_archive(&scratch.0).unwrap().unwrap();
        assert_eq!(manifest.key(), "1.0.0-aaaaaaaaaaaa");
        assert!(RuntimeManifest::parse(&format!(r#"{{"version":"../x","sha256":"{sha}"}}"#)).is_err());
    }
}
