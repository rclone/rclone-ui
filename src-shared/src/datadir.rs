use std::path::{Path, PathBuf};

/// Must match tauri.conf.json `identifier`.
pub const APP_IDENTIFIER: &str = "com.rclone.ui";

/// The one directory every persistent thing lives under: state documents, accounts, schedules
/// and their history, notification targets, rclone configs and binaries, the tunnel binary, the
/// server's log. `storage::migrate` brings it to the current layout at startup.
///
/// It is the platform's *local* data directory (`~/Library/Application Support`,
/// `$XDG_DATA_HOME`, `%LOCALAPPDATA%`) joined with the identifier: what is here is bound to this
/// machine (mount points, downloaded binaries, scheduled tasks), so it must never roam.
#[derive(Debug, Clone)]
pub struct DataDir {
    pub root: PathBuf,
}

impl DataDir {
    /// Headless resolution — the same directory Tauri's `app_local_data_dir` gives the desktop.
    ///
    /// Do NOT add Flatpak `~/.var/app/...` path probing here: inside the sandbox
    /// `dirs::data_local_dir()` already resolves (via XDG_DATA_HOME) to the same remapped path
    /// the GUI writes, so a headless process reads the identical files — extra path rewriting
    /// would only risk pointing at the wrong one.
    pub fn resolve() -> Result<DataDir, String> {
        let local = dirs::data_local_dir().ok_or("could not resolve the local data directory")?;
        Ok(DataDir {
            root: local.join(APP_IDENTIFIER),
        })
    }

    /// `resolve()` with the `RCLONE_UI_DATA_DIR` override honoured (development, tests,
    /// containers).
    pub fn from_env() -> Result<DataDir, String> {
        match std::env::var_os("RCLONE_UI_DATA_DIR").filter(|v| !v.is_empty()) {
            Some(dir) => Ok(DataDir {
                root: PathBuf::from(dir),
            }),
            None => DataDir::resolve(),
        }
    }

    /// Empties the root and keeps the directory itself: state documents, accounts, schedules,
    /// notification targets, rclone configs and downloaded binaries all go (the server's
    /// `--clear`). Returns how many top-level entries were removed; a root that does not exist
    /// is skipped. A filesystem root or the home directory is refused before anything is
    /// touched: what is inside those is not ours.
    pub fn clear(&self) -> Result<usize, String> {
        let Some(dir) = clearable(&self.root)? else {
            return Ok(0);
        };
        let entries = std::fs::read_dir(&dir).map_err(|e| format!("{}: {}", dir.display(), e))?;
        let mut removed = 0;
        for entry in entries {
            let entry = entry.map_err(|e| format!("{}: {}", dir.display(), e))?;
            let path = entry.path();
            // A symlink is a link, not a directory: it goes, what it points at stays.
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let result = if is_dir {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
            result.map_err(|e| format!("{}: {}", path.display(), e))?;
            removed += 1;
        }
        Ok(removed)
    }
}

/// The canonical path of a directory that exists and may be emptied.
fn clearable(dir: &Path) -> Result<Option<PathBuf>, String> {
    if !dir.exists() {
        return Ok(None);
    }
    let canonical = dir
        .canonicalize()
        .map_err(|e| format!("{}: {}", dir.display(), e))?;
    let home = dirs::home_dir().and_then(|home| home.canonicalize().ok());
    if canonical.parent().is_none() || home.as_deref() == Some(canonical.as_path()) {
        return Err(format!(
            "refusing to clear {}: it is not an app directory",
            canonical.display()
        ));
    }
    Ok(Some(canonical))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("rclone-ui-datadir-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn clear_empties_the_root_and_keeps_it() {
        let scratch = scratch("clear");
        let data = DataDir {
            root: scratch.join("root"),
        };
        std::fs::create_dir_all(data.root.join("state/hosts")).unwrap();
        std::fs::write(data.root.join("state/team.json"), "{}").unwrap();
        std::fs::write(data.root.join("storage.json"), "{}").unwrap();
        std::fs::create_dir_all(data.root.join("configs/x")).unwrap();
        std::fs::write(data.root.join("configs/x/rclone.conf"), "").unwrap();

        assert_eq!(data.clear().unwrap(), 3);
        assert!(data.root.is_dir());
        assert_eq!(std::fs::read_dir(&data.root).unwrap().count(), 0);
        std::fs::remove_dir_all(scratch).unwrap();
    }

    #[test]
    fn clear_skips_a_root_that_does_not_exist() {
        let scratch = scratch("missing");
        let data = DataDir {
            root: scratch.join("root"),
        };
        assert_eq!(data.clear().unwrap(), 0);
        assert!(!data.root.exists());
        std::fs::remove_dir_all(scratch).unwrap();
    }

    #[test]
    fn clear_refuses_the_home_and_root_directories() {
        for forbidden in [dirs::home_dir().unwrap(), PathBuf::from("/")] {
            let data = DataDir { root: forbidden };
            let err = data.clear().unwrap_err();
            assert!(err.starts_with("refusing to clear"), "{}", err);
        }
    }
}
