//! Installing a release where the server's own rclone lives: rclone's zip for this machine,
//! checked against its SHA256SUMS, unpacked, probed, and put in place by rename.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use super::binary::{bin_name, MIN_RCLONE_VERSION};
use super::process;
use crate::bus::Bus;
use crate::datadir::DataDir;
use crate::state::ProxySettings;

/// The bus event the pages draw the download bar from (`lib/api/ws.ts` `EventPayloads`).
pub const DOWNLOAD_PROGRESS_EVENT: &str = "rclone.download-progress";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    version: String,
    downloaded: u64,
    total: Option<u64>,
}

fn rclone_os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "osx",
        other => other,
    }
}

fn rclone_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        "i386" | "x86" => "386",
        _ => "unknown",
    }
}

fn canonical(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Parses a (PGP-signed) SHA256SUMS body for the expected hash of `file_name`.
fn expected_sha256(sums: &str, file_name: &str) -> Option<String> {
    // SHA256SUMS is PGP-signed: skip the header/footer and blank lines, match "<hash>  <file>".
    for line in sums.lines() {
        let mut it = line.split_whitespace();
        let Some(hash) = it.next() else {
            continue;
        };
        let name = it.last().unwrap_or("");
        if name == file_name && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(hash.to_ascii_lowercase());
        }
    }
    None
}

static INSTALLING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Downloads `version`, checks it against rclone's SHA256SUMS and puts it at `target`, replacing
/// what is there. The daemon is not stopped first: a rename under a running binary is safe, and
/// a download that fails then leaves rclone running.
pub async fn install(
    dirs: &DataDir,
    bus: &Bus,
    version: &str,
    target: &Path,
    proxy: Option<ProxySettings>,
) -> Result<(), String> {
    let _one = INSTALLING
        .try_lock()
        .map_err(|_| "another rclone install is still running".to_string())?;
    // It goes into a URL and into a folder that is removed: digits and dots only.
    if version.is_empty() || !version.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return Err(format!("not an rclone version: {}", version));
    }
    if crate::version::compare(version, MIN_RCLONE_VERSION) == std::cmp::Ordering::Less {
        return Err(format!(
            "rclone {} is older than {}, which this server needs.",
            version, MIN_RCLONE_VERSION
        ));
    }
    let arch = rclone_arch();
    if arch == "unknown" {
        return Err("Unsupported architecture".to_string());
    }
    let zip_name = format!("rclone-v{}-{}-{}.zip", version, rclone_os(), arch);
    let zip_url = format!("https://downloads.rclone.org/v{}/{}", version, zip_name);
    let sums_url = format!("https://downloads.rclone.org/v{}/SHA256SUMS", version);

    let tmp = dirs.root.join("tmp").join(format!("rclone-{}", version));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let result = match download_verified(
        bus, version, &zip_name, &zip_url, &sums_url, proxy, &tmp,
    )
    .await
    {
        Ok(binary) => place(&binary, target),
        Err(e) => Err(e),
    };
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

/// Puts `staged` where `target` is, by rename. A running rclone keeps the file it started from,
/// and the old file is never written into: macOS kills a signed binary that changed under it.
pub fn place(staged: &Path, target: &Path) -> Result<(), String> {
    let dir = target
        .parent()
        .ok_or_else(|| format!("{} has no folder", target.display()))?;
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("could not create {}: {}", dir.display(), e))?;
    let new = dir.join(format!(".{}.new", bin_name()));
    let _ = std::fs::remove_file(&new);
    std::fs::copy(staged, &new)
        .map_err(|e| format!("could not write to {}: {}", dir.display(), e))?;
    crate::fsutil::set_executable(&new)?;
    // Probed where it will live: the staging folder may sit on a noexec mount.
    if let Err(e) = process::probe_version(&new) {
        let _ = std::fs::remove_file(&new);
        return Err(format!("the downloaded rclone does not run: {}", e));
    }
    #[cfg(windows)]
    {
        // A running exe cannot be replaced, but it can be moved aside.
        let old = dir.join("rclone.old.exe");
        let _ = std::fs::remove_file(&old);
        if target.exists() {
            std::fs::rename(target, &old)
                .map_err(|e| format!("could not move {} aside: {}", target.display(), e))?;
        }
    }
    std::fs::rename(&new, target).map_err(|e| {
        let _ = std::fs::remove_file(&new);
        format!("could not replace {}: {}", target.display(), e)
    })
}

/// The verified, unpacked binary inside `tmp`.
async fn download_verified(
    bus: &Bus,
    version: &str,
    zip_name: &str,
    zip_url: &str,
    sums_url: &str,
    proxy: Option<ProxySettings>,
    tmp: &Path,
) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    use std::io::Write;

    let client = crate::http::proxied(proxy.as_ref(), Duration::from_secs(600))?;

    // 1. Expected checksum (hard requirement).
    let sums = client
        .get(sums_url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch checksums: {}", e))?;
    if !sums.status().is_success() {
        return Err(format!("Checksums unavailable (HTTP {})", sums.status()));
    }
    let sums_body = sums.text().await.map_err(|e| e.to_string())?;
    let expected = expected_sha256(&sums_body, zip_name)
        .ok_or_else(|| format!("No checksum found for {}", zip_name))?;

    // 2. Stream the zip to disk while hashing + reporting progress.
    let zip_path = tmp.join("dl.zip");
    let mut file = std::fs::File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();

    let mut resp = client
        .get(zip_url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed (HTTP {})", resp.status()));
    }
    let total = resp.content_length();
    let mut downloaded: u64 = 0;
    let mut since_emit: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        since_emit += chunk.len() as u64;
        if since_emit >= 262_144 {
            since_emit = 0;
            bus.publish(
                DOWNLOAD_PROGRESS_EVENT,
                DownloadProgress {
                    version: version.to_string(),
                    downloaded,
                    total,
                },
            );
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);

    let actual = format!("{:x}", hasher.finalize());
    if actual != expected {
        return Err(format!(
            "Checksum mismatch for {} (expected {}, got {})",
            zip_name, expected, actual
        ));
    }

    // 3. Extract (zip-slip hardened) and locate the binary.
    let extract_dir = tmp.join("x");
    std::fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;
    unzip_hardened(&zip_path, &extract_dir)?;

    binary_in_archive(&extract_dir)
        .ok_or_else(|| "rclone binary not found in archive".to_string())
}

fn binary_in_archive(dir: &Path) -> Option<PathBuf> {
    let target = bin_name();
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = binary_in_archive(&path) {
                return Some(found);
            }
        } else if entry.file_name().to_string_lossy() == target {
            return Some(path);
        }
    }
    None
}

fn unzip_hardened(zip_path: &Path, out_dir: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let out_canon = canonical(out_dir);

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        // Reject absolute paths / traversal.
        let name = entry
            .enclosed_name()
            .ok_or_else(|| "Unsafe path in archive".to_string())?;
        let outpath = out_dir.join(&name);

        if entry.name().ends_with('/') || entry.name().ends_with('\\') {
            std::fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = outpath.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // Defence in depth: ensure the resolved parent stays inside out_dir.
        if let Some(parent) = outpath.parent() {
            if !canonical(parent).starts_with(&out_canon) {
                return Err("Archive entry escapes output directory".to_string());
            }
        }
        let mut outfile = std::fs::File::create(&outpath).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = entry.unix_mode() {
                let _ = std::fs::set_permissions(&outpath, std::fs::Permissions::from_mode(mode));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws_ts() -> String {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/frontend/lib/api/ws.ts");
        std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {}", path, e))
    }

    /// The Rclone settings section renders the download bar from this event: an emitted name the
    /// page never subscribed to leaves the bar indeterminate for the whole download.
    #[test]
    fn download_events_are_declared_in_ws_ts() {
        assert!(
            ws_ts().contains(&format!("'{}':", DOWNLOAD_PROGRESS_EVENT)),
            "{} is emitted but not declared in lib/api/ws.ts",
            DOWNLOAD_PROGRESS_EVENT
        );
    }

    #[test]
    fn the_checksum_is_read_from_a_signed_sums_file() {
        let sums = "-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n\
            0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  rclone-v1.76.0-osx-arm64.zip\n\
            -----BEGIN PGP SIGNATURE-----\n";
        assert_eq!(
            expected_sha256(sums, "rclone-v1.76.0-osx-arm64.zip").as_deref(),
            Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        );
        assert_eq!(expected_sha256(sums, "rclone-v1.76.0-linux-amd64.zip"), None);
    }

    // A binary is a script here: `rclone version` is all that is ever asked of it.
    #[cfg(unix)]
    #[test]
    fn a_new_rclone_takes_the_place_of_the_old_one() {
        use std::os::unix::fs::PermissionsExt;
        fn fake_rclone(path: &Path, version: &str) {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, format!("#!/bin/sh\necho 'rclone v{}'\n", version)).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let dir = std::env::temp_dir().join(format!("rclone-cloud-place-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let staged = dir.join("staging/rclone");
        let target = dir.join("bin/rclone");
        fake_rclone(&staged, "1.76.0");
        fake_rclone(&target, "1.75.0");
        place(&staged, &target).unwrap();
        assert_eq!(process::probe_version(&target).unwrap(), "1.76.0");
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
        assert!(!dir.join("bin/.rclone.new").exists());
        // One that does not run is never put in place.
        std::fs::write(&staged, "not a program").unwrap();
        assert!(place(&staged, &target)
            .unwrap_err()
            .contains("does not run"));
        assert_eq!(process::probe_version(&target).unwrap(), "1.76.0");
        assert!(!dir.join("bin/.rclone.new").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
