//! Which rclone to run: the one `--rclone-path` names, a custom binary from Settings, the one on
//! PATH, or a fresh install into the machine's bin folder, in that order. Nothing asks.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::ctx::Ctx;
use crate::datadir::DataDir;
use crate::rt;
use crate::scheduler::storeread;
use crate::state_files::{StateStore, APP_DOC};
use crate::zookeeper;

use super::notify;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Named by `--rclone-path`.
    Pinned,
    /// `rclonePath` in the app document: Settings › Rclone's custom binary. Never written to.
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
pub fn find_binary(dirs: &DataDir, pinned: Option<&Path>) -> Result<Option<Found>, String> {
    let probe = |path: &Path, kind: Kind| {
        zookeeper::probe_rclone_version(path).map(|version| Found {
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
    let root = storeread::read_root(dirs).unwrap_or_default();
    if let Some(custom) = root.rclone_path.as_deref().filter(|p| !p.is_empty()) {
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
    let Some(system) = zookeeper::system_rclone() else {
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

pub fn host_proxy(dirs: &DataDir) -> Option<String> {
    storeread::read_host(dirs)
        .ok()
        .and_then(|h| h.proxy)
        .map(|p| p.url)
        .filter(|u| !u.is_empty())
}

pub async fn latest_version() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let text = client
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
pub async fn available_releases(limit: usize) -> Result<Vec<serde_json::Value>, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get("https://api.github.com/repos/rclone/rclone/releases?per_page=30")
        .header("accept", "application/vnd.github+json")
        .header("user-agent", "rclone-ui")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("GitHub API responded {}", response.status()));
    }
    let releases: Vec<serde_json::Value> = response.json().await.map_err(|e| e.to_string())?;
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
            crate::version::compare(v, zookeeper::MIN_RCLONE_VERSION) != std::cmp::Ordering::Less
        })
        .collect();
    out.sort_by(|a, b| crate::version::compare(&b.0, &a.0));
    out.truncate(limit);
    Ok(out
        .into_iter()
        .map(|(version, published_at)| serde_json::json!({ "version": version, "publishedAt": published_at }))
        .collect())
}

/// The rclone to run, installing the latest when the machine has none. `on_download` is called
/// with the version when a download starts.
pub async fn resolve_binary(
    ctx: &Ctx,
    pinned: Option<&Path>,
    on_download: impl Fn(String),
) -> Result<Found, String> {
    let dirs = ctx.dirs.clone();
    let named = pinned.map(Path::to_path_buf);
    let found = rt::spawn_blocking(move || find_binary(&dirs, named.as_deref()))
        .await
        .map_err(|e| format!("could not look for rclone: {}", e))??;
    let found = match found {
        Some(found) => found,
        None => {
            let target = zookeeper::install_target(None).map_err(|reason| {
                format!(
                    "rclone is not installed. {} Install it: {}",
                    reason,
                    zookeeper::install_hint()
                )
            })?;
            let version = latest_version()
                .await
                .map_err(|e| format!("could not determine the latest rclone version: {}", e))?;
            on_download(version.clone());
            log::info!(
                "[lifecycle] installing rclone v{} at {}",
                version,
                target.display()
            );
            zookeeper::install_rclone(ctx, &version, &target, host_proxy(&ctx.dirs))
                .await
                .map_err(|e| format!("failed to install rclone: {}", e))?;
            Found {
                path: target.to_string_lossy().into_owned(),
                version,
                kind: Kind::System,
            }
        }
    };
    zookeeper::check_minimum(&found.version, &found.path)?;
    log::info!(
        "[lifecycle] using rclone {} ({})",
        found.version,
        found.path
    );
    Ok(found)
}

/// For the server's own rclone: a newer stable release replaces it when auto-update is on and
/// the server may write there, otherwise somebody is told once per version. A pinned or a custom
/// binary is never touched. Never fails the start. Returns the version it updated to.
pub async fn maybe_auto_update(
    ctx: &Ctx,
    store: &StateStore,
    found: &Found,
    on_updating: impl Fn(String, String),
) -> Option<String> {
    if found.kind != Kind::System {
        return None;
    }
    let latest = match latest_version().await {
        Ok(latest) => latest,
        Err(e) => {
            log::info!("[lifecycle] update check skipped: {}", e);
            return None;
        }
    };
    if !crate::version::newer(&latest, &found.version) {
        return None;
    }
    let root = storeread::read_root(&ctx.dirs).unwrap_or_default();
    let target = zookeeper::install_target(None);
    if let (true, Ok(target)) = (root.auto_update_rclone, &target) {
        log::info!(
            "[lifecycle] auto-updating rclone {} -> {}",
            found.version,
            latest
        );
        on_updating(found.version.clone(), latest.clone());
        return match zookeeper::install_rclone(ctx, &latest, target, host_proxy(&ctx.dirs)).await {
            Ok(()) => Some(latest),
            Err(e) => {
                log::warn!(
                    "[lifecycle] auto-update failed, keeping {}: {}",
                    found.version,
                    e
                );
                None
            }
        };
    }
    if let Err(reason) = &target {
        log::info!(
            "[lifecycle] rclone v{} is out, not installed: {}",
            latest,
            reason
        );
    }
    if root.last_notified_rclone_version.as_deref() != Some(&latest) {
        let notified = latest.clone();
        let _ = store.update(APP_DOC, |s| {
            s.insert("lastNotifiedRcloneVersion".into(), Value::String(notified));
        });
        let body = format!(
            "rclone v{} is available. You can update from Settings → Rclone.",
            latest
        );
        notify(
            ctx,
            "rclone.update-available",
            "Rclone update available",
            &body,
            serde_json::json!({ "currentVersion": found.version, "latestVersion": latest }),
        );
    }
    None
}

// A binary is a script here: `rclone version` is all that is ever asked of it.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fake_rclone(path: &Path, version: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, format!("#!/bin/sh\necho 'rclone v{}'\n", version)).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn the_pinned_binary_comes_before_the_custom_one() {
        let root = std::env::temp_dir().join(format!("rclone-cloud-find-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dirs = DataDir { root: root.clone() };
        let (pinned, custom) = (root.join("pinned/rclone"), root.join("custom/rclone"));
        fake_rclone(&pinned, "1.60.0");
        fake_rclone(&custom, "1.76.0");
        std::fs::create_dir_all(root.join("state")).unwrap();
        let doc = serde_json::json!({ "version": 1, "state": { "rclonePath": custom } });
        std::fs::write(root.join("state/app.json"), doc.to_string()).unwrap();

        let found = find_binary(&dirs, None).unwrap().unwrap();
        assert_eq!(
            (found.kind, found.version.as_str()),
            (Kind::Custom, "1.76.0")
        );
        // Too old is for the caller to say: this only reports what would run.
        let found = find_binary(&dirs, Some(&pinned)).unwrap().unwrap();
        assert_eq!(
            (found.kind, found.version.as_str()),
            (Kind::Pinned, "1.60.0")
        );
        assert!(zookeeper::check_minimum(&found.version, &found.path).is_err());
        // A pinned binary that does not run is never stepped over.
        let missing = find_binary(&dirs, Some(&root.join("nowhere/rclone")));
        assert!(missing.unwrap_err().contains("--rclone-path"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
