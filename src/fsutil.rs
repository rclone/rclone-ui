//! Filesystem primitives shared by everything that writes under the data directory: the one
//! way a file that must never be seen half-written is replaced (bytes go to a temporary file
//! next to the target, which is then renamed over it; state documents, the accounts file,
//! notification targets and scheduler job files all use it), and a move that survives a
//! volume boundary (the storage migrations and the binary library use it).

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

/// Moves `from` to `to` (a file or a directory tree): a rename when the two share a volume,
/// otherwise a copy followed by the removal of the source. `to`'s parent is created; an
/// existing `to` is an error, never overwritten.
pub fn move_entry(from: &Path, to: &Path) -> Result<(), String> {
    if to.exists() {
        return Err(format!("{} already exists", to.display()));
    }
    if let Some(parent) = to.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create {}: {}", parent.display(), e))?;
        }
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    let meta = std::fs::symlink_metadata(from)
        .map_err(|e| format!("failed to read {}: {}", from.display(), e))?;
    if meta.is_dir() {
        copy_tree(from, to)?;
        std::fs::remove_dir_all(from)
            .map_err(|e| format!("failed to remove {}: {}", from.display(), e))?;
    } else {
        std::fs::copy(from, to).map_err(|e| {
            format!(
                "failed to copy {} to {}: {}",
                from.display(),
                to.display(),
                e
            )
        })?;
        std::fs::remove_file(from)
            .map_err(|e| format!("failed to remove {}: {}", from.display(), e))?;
    }
    Ok(())
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("failed to create {}: {}", to.display(), e))?;
    for entry in std::fs::read_dir(from).map_err(|e| format!("{}: {}", from.display(), e))? {
        let entry = entry.map_err(|e| format!("{}: {}", from.display(), e))?;
        let target = to.join(entry.file_name());
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| {
                format!(
                    "failed to copy {} to {}: {}",
                    entry.path().display(),
                    target.display(),
                    e
                )
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("rcloneui-fsutil-{}-{}", name, std::process::id()));
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
    fn move_entry_moves_files_and_trees_and_never_overwrites() {
        let dir = scratch("move");
        std::fs::create_dir_all(dir.join("src/nested")).unwrap();
        std::fs::write(dir.join("src/nested/a.txt"), b"a").unwrap();
        std::fs::write(dir.join("file.txt"), b"f").unwrap();
        move_entry(&dir.join("src"), &dir.join("dst/tree")).unwrap();
        assert_eq!(
            std::fs::read(dir.join("dst/tree/nested/a.txt")).unwrap(),
            b"a"
        );
        assert!(!dir.join("src").exists());
        move_entry(&dir.join("file.txt"), &dir.join("dst/file.txt")).unwrap();
        assert!(!dir.join("file.txt").exists());
        std::fs::write(dir.join("other.txt"), b"o").unwrap();
        assert!(move_entry(&dir.join("other.txt"), &dir.join("dst/file.txt")).is_err());
        assert_eq!(std::fs::read(dir.join("dst/file.txt")).unwrap(), b"f");
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
