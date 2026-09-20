//! Which rclone runs: the one `--rclone-path` names, a custom binary from Settings, the one on
//! PATH, or a fresh install into the machine's bin folder, in that order. Nothing asks. Also
//! how old it may be, where an install goes, and the auto-update of the server's own rclone.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use super::{install, process, Phase};
use crate::bus::Bus;
use crate::datadir::DataDir;
use crate::notifications::notify;
use crate::state::{Settings, StateStore};

/// The oldest rclone whose RC API has everything the pages call: Serve uses
/// /serve/start|list|stop|stopall (1.70), and every OAuth login reads its sign-in link from
/// /config/oauthstatus and stops through /config/oauthstop (1.75).
pub const MIN_RCLONE_VERSION: &str = "1.75.0";

pub fn bin_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "rclone.exe"
    } else {
        "rclone"
    }
}

/// `origin` is what the message names: a path, or the external daemon.
pub fn check_minimum(version: &str, origin: &str) -> Result<(), String> {
    if crate::version::compare(version, MIN_RCLONE_VERSION) != std::cmp::Ordering::Less {
        return Ok(());
    }
    Err(format!(
        "rclone {} ({}) is older than {}, which this server needs. Update it with `rclone selfupdate` (or reinstall: https://rclone.org/install/).",
        version, origin, MIN_RCLONE_VERSION
    ))
}

// --- where one is, and where one goes ------------------------------------------------------

/// Where an rclone this server installs goes: the directory the machine keeps its binaries in,
/// so it is on everybody's PATH.
pub fn default_target() -> PathBuf {
    #[cfg(windows)]
    {
        // User-writable and on PATH by default.
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\"));
        base.join("Microsoft").join("WindowsApps").join(bin_name())
    }
    #[cfg(not(windows))]
    {
        PathBuf::from("/usr/local/bin").join(bin_name())
    }
}

/// What to tell somebody whose machine has no rclone and whose server may not install one.
pub fn install_hint() -> &'static str {
    if cfg!(windows) {
        "winget install Rclone.Rclone"
    } else {
        "sudo -v ; curl https://rclone.org/install.sh | sudo bash"
    }
}

/// The first rclone on `path_var`. Taken as an argument so tests need not touch the process's.
pub fn find_on_path(path_var: &std::ffi::OsStr) -> Option<PathBuf> {
    std::env::split_paths(path_var)
        .map(|dir| dir.join(bin_name()))
        .find(|candidate| candidate.is_file())
}

/// The rclone this server runs when nothing names another: the one on PATH, else the one where
/// it installs (a systemd unit or a Windows service may not have that directory on its PATH).
pub fn system_rclone() -> Option<PathBuf> {
    std::env::var_os("PATH")
        .and_then(|path_var| find_on_path(&path_var))
        .or_else(|| Some(default_target()).filter(|target| target.is_file()))
}

/// Whether this process may create or replace a file in `dir`, or in the nearest ancestor that
/// exists. Touches nothing.
fn may_write(dir: &Path) -> bool {
    let Some(existing) = dir.ancestors().find(|ancestor| ancestor.is_dir()) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(path) = std::ffi::CString::new(existing.as_os_str().as_bytes()) else {
            return false;
        };
        // SAFETY: `path` is a NUL-terminated string that outlives the call.
        unsafe { libc::access(path.as_ptr(), libc::W_OK | libc::X_OK) == 0 }
    }
    #[cfg(not(unix))]
    {
        // The install itself gives the real answer.
        let _ = existing;
        true
    }
}

/// Where an install goes: the rclone on PATH, in place, or `default` when there is none. A custom
/// binary is not looked at: this is what runs once that setting is cleared, and nothing is ever
/// written where a custom binary lives. `Err` is the reason there is nowhere to install.
pub fn install_target_for(
    pinned: Option<&Path>,
    system: Option<&Path>,
    default: &Path,
) -> Result<PathBuf, String> {
    let target = system.unwrap_or(default).to_path_buf();
    if pinned.is_some_and(|pinned| pinned != target) {
        return Err("rclone is pinned by --rclone-path.".to_string());
    }
    // Never resolved: Homebrew, snap, nix and the desktop app link into trees of their own.
    let is_link = target
        .symlink_metadata()
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false);
    if is_link {
        return Err(format!(
            "{} is a link into another installation, and this server does not write through it.",
            target.display()
        ));
    }
    let dir = target.parent().unwrap_or(Path::new("/"));
    if !may_write(dir) {
        return Err(format!("This server may not write to {}.", dir.display()));
    }
    Ok(target)
}

pub fn install_target(pinned: Option<&Path>) -> Result<PathBuf, String> {
    install_target_for(pinned, system_rclone().as_deref(), &default_target())
}

// --- which one runs --------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Named by `--rclone-path`.
    Pinned,
    /// `rclonePath` in the document: Settings › Rclone's custom binary. Never written to.
    Custom,
    /// The server's own: on PATH, or where it installs one.
    System,
}

#[derive(Debug, Clone)]
pub struct Found {
    pub path: String,
    pub version: String,
    pub kind: Kind,
}

/// The rclone that would run, without installing one. Blocks: it runs `rclone version`. `Err`
/// only for a pinned binary that does not run, which is never stepped over.
pub fn find_binary(settings: &Settings, pinned: Option<&Path>) -> Result<Option<Found>, String> {
    let probe = |path: &Path, kind: Kind| {
        process::probe_version(path).map(|version| Found {
            path: path.to_string_lossy().into_owned(),
            version,
            kind,
        })
    };
    if let Some(path) = pinned {
        return probe(path, Kind::Pinned).map(Some).map_err(|e| {
            format!(
                "the rclone named by --rclone-path is unusable ({}): {}",
                path.display(),
                e
            )
        });
    }
    if let Some(custom) = settings.rclone_path.as_deref().filter(|p| !p.is_empty()) {
        match probe(Path::new(custom), Kind::Custom) {
            Ok(found) => return Ok(Some(found)),
            // The setting stays: Settings says it is not the one in use.
            Err(e) => log::warn!(
                "[lifecycle] the custom rclone {} is unusable: {}",
                custom,
                e
            ),
        }
    }
    let Some(system) = system_rclone() else {
        return Ok(None);
    };
    match probe(&system, Kind::System) {
        Ok(found) => Ok(Some(found)),
        Err(e) => {
            log::warn!(
                "[lifecycle] the rclone at {} is unusable: {}",
                system.display(),
                e
            );
            Ok(None)
        }
    }
}

pub async fn latest_version() -> Result<String, String> {
    let text = crate::http::client(Duration::from_secs(20))
        .get("https://downloads.rclone.org/version.txt")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    text.split('v')
        .nth(1)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("unexpected version.txt contents: {}", text.trim()))
}

/// Stable rclone releases this server can run, newest first (lib/rclone/versions.ts
/// `fetchAvailableVersions`). Best-effort: GitHub's API is rate limited.
pub async fn available_releases(limit: usize) -> Result<Vec<Value>, String> {
    let response = crate::http::client(Duration::from_secs(20))
        .get("https://api.github.com/repos/rclone/rclone/releases?per_page=30")
        .header("accept", "application/vnd.github+json")
        .header("user-agent", "rclone-cloud")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("GitHub API responded {}", response.status()));
    }
    let releases: Vec<Value> = response.json().await.map_err(|e| e.to_string())?;
    let mut out: Vec<(String, String)> = releases
        .iter()
        .filter(|r| {
            !r["prerelease"].as_bool().unwrap_or(false) && !r["draft"].as_bool().unwrap_or(false)
        })
        .filter_map(|r| {
            let version = r["tag_name"].as_str()?.trim_start_matches('v').to_string();
            let published = r["published_at"].as_str().unwrap_or("").to_string();
            Some((version, published))
        })
        .filter(|(v, _)| {
            crate::version::compare(v, MIN_RCLONE_VERSION) != std::cmp::Ordering::Less
        })
        .collect();
    out.sort_by(|a, b| crate::version::compare(&b.0, &a.0));
    out.truncate(limit);
    Ok(out
        .into_iter()
        .map(|(version, published_at)| serde_json::json!({ "version": version, "publishedAt": published_at }))
        .collect())
}

/// The rclone to run: found, or the latest installed when the machine has none, then updated
/// when it is the server's own and out of date. `phase` is told about a download or an update
/// while it runs. It is replaced where it lives, so the path to run does not change.
pub async fn resolve(
    dirs: &DataDir,
    bus: &Bus,
    store: &StateStore,
    pinned: Option<&Path>,
    phase: &(dyn Fn(Phase) + Sync),
) -> Result<Found, String> {
    let settings = store.settings();
    let proxy = settings.active_proxy().cloned();
    let named = pinned.map(Path::to_path_buf);
    let found = tokio::task::spawn_blocking(move || find_binary(&settings, named.as_deref()))
        .await
        .map_err(|e| format!("could not look for rclone: {}", e))??;
    let found = match found {
        Some(found) => found,
        None => {
            let target = install_target(None).map_err(|reason| {
                format!(
                    "rclone is not installed. {} Install it: {}",
                    reason,
                    install_hint()
                )
            })?;
            let version = latest_version()
                .await
                .map_err(|e| format!("could not determine the latest rclone version: {}", e))?;
            phase(Phase::Downloading {
                version: version.clone(),
            });
            log::info!(
                "[lifecycle] installing rclone v{} at {}",
                version,
                target.display()
            );
            install::install(dirs, bus, &version, &target, proxy)
                .await
                .map_err(|e| format!("failed to install rclone: {}", e))?;
            Found {
                path: target.to_string_lossy().into_owned(),
                version,
                kind: Kind::System,
            }
        }
    };
    check_minimum(&found.version, &found.path)?;
    log::info!(
        "[lifecycle] using rclone {} ({})",
        found.version,
        found.path
    );
    maybe_auto_update(dirs, bus, store, &found, phase).await;
    Ok(found)
}

/// For the server's own rclone: a newer stable release replaces it when auto-update is on and
/// the server may write there, otherwise somebody is told once per version. A pinned or a custom
/// binary is never touched. Never fails the start.
async fn maybe_auto_update(
    dirs: &DataDir,
    bus: &Bus,
    store: &StateStore,
    found: &Found,
    phase: &(dyn Fn(Phase) + Sync),
) {
    if found.kind != Kind::System {
        return;
    }
    let latest = match latest_version().await {
        Ok(latest) => latest,
        Err(e) => {
            log::info!("[lifecycle] update check skipped: {}", e);
            return;
        }
    };
    if !crate::version::newer(&latest, &found.version) {
        return;
    }
    let settings = store.settings();
    let target = install_target(None);
    if let (true, Ok(target)) = (settings.auto_update(), &target) {
        log::info!(
            "[lifecycle] auto-updating rclone {} -> {}",
            found.version,
            latest
        );
        phase(Phase::Updating {
            from: found.version.clone(),
            to: latest.clone(),
        });
        if let Err(e) = install::install(
            dirs,
            bus,
            &latest,
            target,
            settings.active_proxy().cloned(),
        )
        .await
        {
            log::warn!(
                "[lifecycle] auto-update failed, keeping {}: {}",
                found.version,
                e
            );
        }
        return;
    }
    if let Err(reason) = &target {
        log::info!(
            "[lifecycle] rclone v{} is out, not installed: {}",
            latest,
            reason
        );
    }
    if settings.last_notified_rclone_version.as_deref() != Some(&latest) {
        let notified = latest.clone();
        let _ = store.update(|s| {
            s.insert("lastNotifiedRcloneVersion".into(), Value::String(notified));
        });
        let body = format!(
            "rclone v{} is available. You can update from Settings → Rclone.",
            latest
        );
        notify(
            dirs,
            "rclone.update-available",
            "Rclone update available",
            &body,
            serde_json::json!({ "currentVersion": found.version, "latestVersion": latest }),
        );
    }
}

#[cfg(test)]
mod minimum_tests {
    use super::*;

    #[test]
    fn an_older_rclone_is_told_to_update_itself() {
        assert!(check_minimum("1.75.0", "/usr/bin/rclone").is_ok());
        assert!(check_minimum("1.75.1", "/usr/bin/rclone").is_ok());
        // A beta or a developer build of a new enough release is new enough.
        assert!(check_minimum("1.76.0-beta.10370.b93b73bcb", "x").is_ok());
        assert!(check_minimum("1.76.0-DEV", "x").is_ok());
        let error = check_minimum("1.60.0", "/usr/bin/rclone").unwrap_err();
        assert!(error.contains("1.60.0") && error.contains("/usr/bin/rclone"));
        assert!(error.contains("rclone selfupdate") && error.contains(MIN_RCLONE_VERSION));
    }
}

// A binary is a script here: `rclone version` is all that is ever asked of it.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("rclone-cloud-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fake_rclone(path: &Path, version: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, format!("#!/bin/sh\necho 'rclone v{}'\n", version)).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn the_first_rclone_on_path_is_the_one() {
        let dir = scratch("path");
        fake_rclone(&dir.join("second/rclone"), "1.75.0");
        fake_rclone(&dir.join("first/rclone"), "1.76.0");
        std::fs::create_dir_all(dir.join("empty")).unwrap();
        let path_var =
            std::env::join_paths([dir.join("empty"), dir.join("first"), dir.join("second")])
                .unwrap();
        assert_eq!(find_on_path(&path_var), Some(dir.join("first/rclone")));
        assert_eq!(find_on_path(std::ffi::OsStr::new("")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_pinned_binary_comes_before_the_custom_one() {
        let dir = scratch("find");
        let (pinned, custom) = (dir.join("pinned/rclone"), dir.join("custom/rclone"));
        fake_rclone(&pinned, "1.60.0");
        fake_rclone(&custom, "1.76.0");
        let settings = Settings {
            rclone_path: Some(custom.to_string_lossy().into_owned()),
            ..Default::default()
        };

        let found = find_binary(&settings, None).unwrap().unwrap();
        assert_eq!(
            (found.kind, found.version.as_str()),
            (Kind::Custom, "1.76.0")
        );
        // Too old is for the caller to say: this only reports what would run.
        let found = find_binary(&settings, Some(&pinned)).unwrap().unwrap();
        assert_eq!(
            (found.kind, found.version.as_str()),
            (Kind::Pinned, "1.60.0")
        );
        assert!(check_minimum(&found.version, &found.path).is_err());
        // A pinned binary that does not run is never stepped over.
        let missing = find_binary(&settings, Some(&dir.join("nowhere/rclone")));
        assert!(missing.unwrap_err().contains("--rclone-path"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_install_goes_where_the_servers_own_rclone_lives() {
        let dir = scratch("target");
        let default = dir.join("usr-local-bin/rclone");
        let system = dir.join("opt/rclone");
        fake_rclone(&system, "1.75.0");
        // The rclone on PATH, in place; with none, the machine's bin folder.
        assert_eq!(
            install_target_for(None, Some(&system), &default),
            Ok(system.clone())
        );
        assert_eq!(
            install_target_for(None, None, &default),
            Ok(default.clone())
        );
        // Pinned there (the Docker image) is fine; pinned anywhere else leaves nothing to install.
        assert_eq!(
            install_target_for(Some(&system), Some(&system), &default),
            Ok(system.clone())
        );
        let pinned =
            install_target_for(Some(&dir.join("elsewhere/rclone")), Some(&system), &default);
        assert!(pinned.unwrap_err().contains("--rclone-path"));
        // A link into somebody else's installation is never written through.
        let link = dir.join("brew/rclone");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&system, &link).unwrap();
        assert!(install_target_for(None, Some(&link), &default)
            .unwrap_err()
            .contains("link"));
        // Nor is a folder this process may not write to.
        let locked = dir.join("locked");
        std::fs::create_dir_all(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
        let refused = install_target_for(None, None, &locked.join("rclone"));
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Root may write anywhere, so this holds for everybody else.
        if unsafe { libc::geteuid() } != 0 {
            assert!(refused.unwrap_err().contains("may not write"));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
