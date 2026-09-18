//! Which rclone binary to run — the server flavor of lib/rclone/init.ts `resolveActiveRclone`
//! + `provisionRclone` + `maybeAutoUpdateRclone`. Same ladder, minus the dialogs: a system
//! rclone is adopted rather than offered, and a missing binary is downloaded without asking.

use std::path::Path;
use std::time::Duration;

use serde_json::Value;

use crate::ctx::Ctx;
use crate::rt;
use crate::scheduler::storeread;
use crate::state_files::{StateStore, APP_DOC};
use crate::zookeeper;

use super::interaction::{ask, Decision, Question, SharedInteraction};
use super::notify;

async fn validate(ctx: &Ctx, path: &str) -> Option<String> {
    let ctx = ctx.clone();
    let path = path.to_string();
    match rt::spawn_blocking(move || zookeeper::validate_rclone_binary(&ctx, path)).await {
        Ok(Ok(version)) => Some(version),
        Ok(Err(e)) => {
            log::warn!("[lifecycle] rclone binary unusable: {}", e);
            None
        }
        Err(e) => {
            log::warn!("[lifecycle] validate task failed: {}", e);
            None
        }
    }
}

fn persist_rclone_path(store: &StateStore, path: &str) {
    let path = path.to_string();
    if let Err(e) = store.update(APP_DOC, |s| {
        s.insert("rclonePath".into(), Value::String(path));
    }) {
        log::warn!("[lifecycle] could not persist rclonePath: {}", e);
    }
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

/// Stable rclone releases at or above `min_version`, newest first (lib/rclone/versions.ts
/// `fetchAvailableVersions`). Best-effort: GitHub's API is rate limited.
pub async fn available_releases(
    min_version: &str,
    limit: usize,
) -> Result<Vec<serde_json::Value>, String> {
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
        .filter(|(v, _)| crate::version::compare(v, min_version) != std::cmp::Ordering::Less)
        .collect();
    out.sort_by(|a, b| crate::version::compare(&b.0, &a.0));
    out.truncate(limit);
    Ok(out
        .into_iter()
        .map(|(version, published_at)| serde_json::json!({ "version": version, "publishedAt": published_at }))
        .collect())
}

/// Resolves (and persists) the binary to run. `on_download` is called with the version when a
/// download starts.
pub async fn resolve_binary(
    ctx: &Ctx,
    store: &StateStore,
    interaction: &SharedInteraction,
    override_path: Option<&Path>,
    on_download: impl Fn(String),
) -> Result<String, String> {
    if let Some(path) = override_path {
        let path = path.to_string_lossy().into_owned();
        return match validate(ctx, &path).await {
            Some(version) => {
                log::info!(
                    "[lifecycle] using rclone {} from --rclone-path ({})",
                    version,
                    path
                );
                persist_rclone_path(store, &path);
                Ok(path)
            }
            None => Err(format!(
                "the configured rclone binary is unusable: {}",
                path
            )),
        };
    }

    let root = storeread::read_root(&ctx.dirs).unwrap_or_default();

    if let Some(stored) = root.rclone_path.as_deref().filter(|p| !p.is_empty()) {
        if let Some(version) = validate(ctx, stored).await {
            log::info!("[lifecycle] using stored rclone {} ({})", version, stored);
            return Ok(stored.to_string());
        }
        // Self-heal a managed version whose absolute path moved (data dir relocated).
        let managed = stored
            .split(['/', '\\'])
            .skip_while(|seg| *seg != "rclone-versions")
            .nth(1)
            .and_then(|v| v.strip_prefix('v'))
            .map(str::to_string);
        if let Some(version) = managed {
            if let Ok(Some(healed)) = zookeeper::managed_version_path(ctx, version) {
                if validate(ctx, &healed).await.is_some() {
                    log::info!("[lifecycle] self-healed managed rclone path -> {}", healed);
                    persist_rclone_path(store, &healed);
                    return Ok(healed);
                }
            }
        }
    }

    // 1. A system rclone on PATH: the host decides (the desktop asks, the server adopts).
    if let Ok(Some(system)) = zookeeper::find_system_rclone(ctx) {
        if let Some(version) = validate(ctx, &system).await {
            let question = Question::AdoptSystemRclone {
                path: system.clone(),
                version: version.clone(),
            };
            if ask(interaction, question).await == Decision::Yes {
                log::info!(
                    "[lifecycle] adopting system rclone {} ({})",
                    version,
                    system
                );
                persist_rclone_path(store, &system);
                return Ok(system);
            }
            log::info!(
                "[lifecycle] system rclone {} declined; managing our own copy",
                system
            );
        }
    }

    // 2. Newest downloaded version that still runs.
    match zookeeper::list_downloaded_rclone_versions(ctx) {
        Ok(downloaded) => {
            for candidate in downloaded {
                if validate(ctx, &candidate.path).await.is_some() {
                    persist_rclone_path(store, &candidate.path);
                    return Ok(candidate.path);
                }
                log::warn!(
                    "[lifecycle] skipping unusable downloaded rclone {}",
                    candidate.path
                );
            }
        }
        Err(e) => log::warn!("[lifecycle] list_downloaded_rclone_versions failed: {}", e),
    }

    // 4. Nothing anywhere: download the latest stable release.
    let version = latest_version()
        .await
        .map_err(|e| format!("could not determine the latest rclone version: {}", e))?;
    on_download(version.clone());
    log::info!("[lifecycle] downloading rclone v{}", version);
    let proxy = storeread::read_host(&ctx.dirs)
        .ok()
        .and_then(|h| h.proxy)
        .map(|p| p.url)
        .filter(|u| !u.is_empty());
    let path = zookeeper::download_rclone_version(ctx, version, proxy)
        .await
        .map_err(|e| format!("failed to download rclone: {}", e))?;
    persist_rclone_path(store, &path);
    Ok(path)
}

/// For a managed binary: download a newer stable release when auto-update is on, otherwise
/// notify once per version. Never fails the start.
/// Returns the path to run and whether it was just updated.
pub async fn maybe_auto_update(
    ctx: &Ctx,
    store: &StateStore,
    current: String,
    on_updating: impl Fn(String, String),
) -> (String, bool) {
    let active = match zookeeper::classify_rclone_path(ctx, current.clone()) {
        Ok(active) => active,
        Err(_) => return (current, false),
    };
    let Some(current_version) = active.version.filter(|_| active.kind == "managed") else {
        return (current, false);
    };
    let latest = match latest_version().await {
        Ok(latest) => latest,
        Err(e) => {
            log::info!("[lifecycle] update check skipped: {}", e);
            return (current, false);
        }
    };
    if crate::version::compare(&latest, &current_version) != std::cmp::Ordering::Greater {
        return (current, false);
    }
    let root = storeread::read_root(&ctx.dirs).unwrap_or_default();
    if !root.auto_update_rclone {
        if root.last_notified_rclone_version.as_deref() != Some(&latest) {
            let notified = latest.clone();
            let _ = store.update(APP_DOC, |s| {
                s.insert("lastNotifiedRcloneVersion".into(), Value::String(notified));
            });
            let body = format!(
                "rclone v{} is available. You can update from Settings → Binary.",
                latest
            );
            notify(
                ctx,
                "rclone.update-available",
                "Rclone update available",
                &body,
                serde_json::json!({ "currentVersion": current_version, "latestVersion": latest }),
            );
        }
        return (current, false);
    }
    log::info!(
        "[lifecycle] auto-updating rclone {} -> {}",
        current_version,
        latest
    );
    on_updating(current_version.clone(), latest.clone());
    let proxy = storeread::read_host(&ctx.dirs)
        .ok()
        .and_then(|h| h.proxy)
        .map(|p| p.url)
        .filter(|u| !u.is_empty());
    match zookeeper::download_rclone_version(ctx, latest, proxy).await {
        Ok(path) => {
            persist_rclone_path(store, &path);
            (path, true)
        }
        Err(e) => {
            log::warn!("[lifecycle] auto-update failed, keeping {}: {}", current, e);
            (current, false)
        }
    }
}
