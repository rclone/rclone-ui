//! Filesystem primitives shared by everything that writes under the data directory: the one
//! way a file that must never be seen half-written is replaced (bytes go to a temporary file
//! next to the target, which is then renamed over it; state documents, the accounts file,
//! notification targets and scheduler task files all use it), and the one way a binary this
//! server put on disk is made runnable.

use std::path::Path;

/// Writes `bytes` to `path` atomically: the parent directory is created, the bytes land in
/// `<path>.tmp` beside the target, and a rename replaces the target. A failed step leaves no
/// temporary file behind. Callers keep their own locks; this only orders the writes.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create {}: {}", parent.display(), e))?;
        }
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    std::fs::write(&tmp, bytes).map_err(|e| format!("failed to write {}: {}", tmp.display(), e))?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("failed to replace {}: {}", path.display(), e));
    }
    Ok(())
}

/// Marks `path` executable (0o755). Nothing to do on Windows, where the extension decides.
pub fn set_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("could not make {} executable: {}", path.display(), e))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rclone-cloud-fsutil-{}-{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn replaces_the_target_and_creates_the_parent() {
        let dir = scratch("replace");
        let file = dir.join("nested").join("doc.json");
        write_atomic(&file, b"one").unwrap();
        write_atomic(&file, b"two").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"two");
        assert!(!dir.join("nested").join("doc.json.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_replace_leaves_no_temporary_file() {
        let dir = scratch("fail");
        std::fs::create_dir_all(&dir).unwrap();
        // The target is a non-empty directory: the rename over it fails.
        let target = dir.join("busy");
        std::fs::create_dir_all(target.join("inside")).unwrap();
        assert!(write_atomic(&target, b"x").is_err());
        assert!(!dir.join("busy.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
