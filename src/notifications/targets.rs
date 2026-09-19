//! The Rust-owned notification-target store: `<app_data>/notifications/targets.json`.
//!
//! The pages write it through commands and dispatch records delivery outcomes into it, so every
//! read-modify-write cycle runs under a lock. It is a cross-process one because a second server
//! may be pointed at the same data directory. The lock file is separate from the data file so
//! the atomic tmp+rename data writes never disturb the held lock fd.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::scheduler::storeread::DataDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationTarget {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub url: String,
    pub is_enabled: bool,
    pub events: Vec<String>,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sent_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTarget {
    pub provider: String,
    pub name: String,
    pub url: String,
    pub is_enabled: bool,
    pub events: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetPatch {
    pub name: Option<String>,
    pub url: Option<String>,
    pub events: Option<Vec<String>>,
    pub is_enabled: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
struct TargetsFile {
    version: u32,
    targets: Vec<NotificationTarget>,
}

fn notifications_dir(dirs: &DataDir) -> PathBuf {
    dirs.root.join("notifications")
}

fn targets_path(dirs: &DataDir) -> PathBuf {
    notifications_dir(dirs).join("targets.json")
}

fn lock_file_path(dirs: &DataDir) -> PathBuf {
    notifications_dir(dirs).join("targets.lock")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Cross-process mutual exclusion for targets.json read-modify-write cycles. Held for
/// milliseconds (never across HTTP sends). Unix: kernel flock — released on crash; release
/// truncates but never unlinks (an unlink/recreate race
/// would let two processes lock two inodes of the same path). Windows: create_new existence
/// with a stale break well above any real hold time.
pub struct StoreLock {
    #[cfg(unix)]
    _file: std::fs::File,
    #[cfg(not(unix))]
    path: PathBuf,
}

#[cfg(not(unix))]
impl Drop for StoreLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

const LOCK_ATTEMPTS: u32 = 40;
const LOCK_RETRY_MS: u64 = 250;
#[cfg(not(unix))]
const LOCK_STALE_MS: u64 = 30_000;

#[cfg(unix)]
fn acquire_store_lock(dirs: &DataDir) -> Result<StoreLock, String> {
    use std::os::unix::io::AsRawFd;

    let path = lock_file_path(dirs);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| format!("failed to open notifications lock: {}", e))?;
    for attempt in 0..LOCK_ATTEMPTS {
        let locked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
        if locked {
            return Ok(StoreLock { _file: file });
        }
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() != Some(libc::EWOULDBLOCK) {
            return Err(format!("failed to lock {}: {}", path.display(), err));
        }
        if attempt + 1 < LOCK_ATTEMPTS {
            std::thread::sleep(std::time::Duration::from_millis(LOCK_RETRY_MS));
        }
    }
    Err("another notifications operation is still in progress".to_string())
}

#[cfg(not(unix))]
fn acquire_store_lock(dirs: &DataDir) -> Result<StoreLock, String> {
    let path = lock_file_path(dirs);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    for attempt in 0..LOCK_ATTEMPTS {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                use std::io::Write;
                let _ = write!(file, "{}", now_ms());
                return Ok(StoreLock { path });
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                // Holds are milliseconds; anything older than the stale window is a crashed
                // process that never got to its Drop.
                let stale = std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|raw| raw.trim().parse::<u64>().ok())
                    .map(|written| now_ms().saturating_sub(written) > LOCK_STALE_MS)
                    .unwrap_or(true);
                if stale {
                    let _ = std::fs::remove_file(&path);
                    continue;
                }
                if attempt + 1 < LOCK_ATTEMPTS {
                    std::thread::sleep(std::time::Duration::from_millis(LOCK_RETRY_MS));
                }
            }
            Err(e) => return Err(format!("failed to create notifications lock: {}", e)),
        }
    }
    Err("another notifications operation is still in progress".to_string())
}

fn write_targets(dirs: &DataDir, targets: &[NotificationTarget]) -> Result<(), String> {
    let path = targets_path(dirs);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create notifications dir: {}", e))?;
    }
    let file = TargetsFile {
        version: 1,
        targets: targets.to_vec(),
    };
    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| format!("failed to serialize targets: {}", e))?;
    crate::fsutil::write_atomic(&path, json.as_bytes())
        .map_err(|e| format!("failed to save targets: {}", e))
}

fn load_locked(dirs: &DataDir) -> Result<Vec<NotificationTarget>, String> {
    let path = targets_path(dirs);
    match std::fs::read_to_string(&path) {
        Ok(raw) => {
            let file: TargetsFile = serde_json::from_str(&raw)
                .map_err(|e| format!("invalid targets file {}: {}", path.display(), e))?;
            Ok(file.targets)
        }
        // Not created until the first add — a missing file simply means no targets.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("failed to read {}: {}", path.display(), e)),
    }
}

pub fn load(dirs: &DataDir) -> Result<Vec<NotificationTarget>, String> {
    let _lock = acquire_store_lock(dirs)?;
    load_locked(dirs)
}

/// The same sentence the drawer says from its own snapshot: an email target's `url` is its
/// recipients, every other's is a webhook URL.
fn duplicate_error(provider: &str) -> String {
    if provider == "email" {
        "An email notification to these addresses is already configured.".to_string()
    } else {
        "A webhook with this URL is already configured.".to_string()
    }
}

pub fn add(dirs: &DataDir, new: NewTarget) -> Result<NotificationTarget, String> {
    let _lock = acquire_store_lock(dirs)?;
    let mut targets = load_locked(dirs)?;
    // Re-checked here under the lock: the drawer's duplicate check reads a snapshot that
    // another window (or a concurrent add) may have outdated.
    let new_url = new.url.trim().to_lowercase();
    if targets
        .iter()
        .any(|t| t.url.trim().to_lowercase() == new_url)
    {
        return Err(duplicate_error(&new.provider));
    }
    let target = NotificationTarget {
        id: uuid::Uuid::new_v4().to_string(),
        provider: new.provider,
        name: new.name,
        url: new.url,
        is_enabled: new.is_enabled,
        events: new.events,
        created_at: now_ms(),
        last_sent_at: None,
        last_error: None,
    };
    targets.push(target.clone());
    write_targets(dirs, &targets)?;
    Ok(target)
}

pub fn update(dirs: &DataDir, id: &str, patch: TargetPatch) -> Result<(), String> {
    let _lock = acquire_store_lock(dirs)?;
    let mut targets = load_locked(dirs)?;
    if let Some(new_url) = &patch.url {
        let normalized = new_url.trim().to_lowercase();
        if targets
            .iter()
            .any(|t| t.id != id && t.url.trim().to_lowercase() == normalized)
        {
            // The patch carries no provider; the target being edited says which words fit.
            let provider = targets
                .iter()
                .find(|t| t.id == id)
                .map(|t| t.provider.as_str())
                .unwrap_or_default();
            return Err(duplicate_error(provider));
        }
    }
    let Some(target) = targets.iter_mut().find(|t| t.id == id) else {
        return Err("Notification target not found.".to_string());
    };
    if let Some(name) = patch.name {
        target.name = name;
    }
    if let Some(url) = patch.url {
        target.url = url;
    }
    if let Some(events) = patch.events {
        target.events = events;
    }
    if let Some(is_enabled) = patch.is_enabled {
        target.is_enabled = is_enabled;
    }
    write_targets(dirs, &targets)
}

/// Idempotent: removing an id that's already gone is a success, not an error.
pub fn remove(dirs: &DataDir, id: &str) -> Result<(), String> {
    let _lock = acquire_store_lock(dirs)?;
    let mut targets = load_locked(dirs)?;
    let before = targets.len();
    targets.retain(|t| t.id != id);
    if targets.len() == before {
        return Ok(());
    }
    write_targets(dirs, &targets)
}

/// Record per-target delivery results (`None` = success). Called after the HTTP sends finished,
/// so the lock was NOT held during them; targets deleted mid-send are skipped silently.
pub fn record_outcomes(dirs: &DataDir, outcomes: &[(String, Option<String>)]) {
    if outcomes.is_empty() {
        return;
    }
    let Ok(_lock) = acquire_store_lock(dirs) else {
        return;
    };
    let Ok(mut targets) = load_locked(dirs) else {
        return;
    };
    let now = now_ms();
    let mut changed = false;
    for (id, error) in outcomes {
        if let Some(target) = targets.iter_mut().find(|t| &t.id == id) {
            target.last_sent_at = Some(now);
            target.last_error = error.clone();
            changed = true;
        }
    }
    if changed {
        let _ = write_targets(dirs, &targets);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dirs(tag: &str) -> DataDir {
        let root = std::env::temp_dir().join(format!("rclone-cloud-targets-test-{}", tag));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        DataDir { root }
    }

    #[test]
    fn missing_file_means_no_targets_and_is_not_created_by_reads() {
        let dirs = test_dirs("missing");
        assert!(load(&dirs).unwrap().is_empty());
        assert!(!dirs.root.join("notifications/targets.json").exists());
        let _ = std::fs::remove_dir_all(&dirs.root);
    }

    #[test]
    fn add_update_remove_lifecycle() {
        let dirs = test_dirs("crud");
        let added = add(
            &dirs,
            NewTarget {
                provider: "webhook".into(),
                name: "Hook".into(),
                url: "https://example.com/hook".into(),
                is_enabled: true,
                events: vec!["schedule.completed".into()],
            },
        )
        .unwrap();
        assert!(!added.id.is_empty());
        assert!(added.created_at > 0);

        // The written file is camelCase, the page's NotificationTarget shape.
        let raw = std::fs::read_to_string(dirs.root.join("notifications/targets.json")).unwrap();
        assert!(raw.contains("\"isEnabled\": true"));
        assert!(raw.contains("\"createdAt\":"));

        // Duplicate URL (case/whitespace-insensitive) is rejected under the lock.
        let dup = add(
            &dirs,
            NewTarget {
                provider: "webhook".into(),
                name: "Other".into(),
                url: "  HTTPS://EXAMPLE.COM/HOOK ".into(),
                is_enabled: true,
                events: vec![],
            },
        );
        assert!(dup.unwrap_err().contains("already configured"));

        update(
            &dirs,
            &added.id,
            TargetPatch {
                name: Some("Renamed".into()),
                is_enabled: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
        let targets = load(&dirs).unwrap();
        assert_eq!(targets[0].name, "Renamed");
        assert!(!targets[0].is_enabled);

        assert!(update(&dirs, "nope", TargetPatch::default())
            .unwrap_err()
            .contains("not found"));

        remove(&dirs, &added.id).unwrap();
        remove(&dirs, &added.id).unwrap(); // idempotent
        assert!(load(&dirs).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dirs.root);
    }

    /// An email target's `url` is its recipients, so a duplicate is refused in those words —
    /// on add, and on an edit that moves another target onto the same addresses.
    #[test]
    fn an_email_duplicate_is_refused_in_its_own_words() {
        let dirs = test_dirs("email-dup");
        let mail = |name: &str, url: &str| NewTarget {
            provider: "email".into(),
            name: name.into(),
            url: url.into(),
            is_enabled: true,
            events: vec![],
        };
        add(&dirs, mail("Ops", "ops@example.com, alice@example.com")).unwrap();
        assert_eq!(
            add(&dirs, mail("Again", " OPS@example.com, alice@example.com ")).unwrap_err(),
            "An email notification to these addresses is already configured."
        );
        let other = add(&dirs, mail("Other", "other@example.com")).unwrap();
        assert_eq!(
            update(
                &dirs,
                &other.id,
                TargetPatch {
                    url: Some("ops@example.com, alice@example.com".into()),
                    ..Default::default()
                },
            )
            .unwrap_err(),
            "An email notification to these addresses is already configured."
        );
        // A webhook keeps its own sentence.
        add(
            &dirs,
            NewTarget {
                provider: "webhook".into(),
                name: "Hook".into(),
                url: "https://example.com/hook".into(),
                is_enabled: true,
                events: vec![],
            },
        )
        .unwrap();
        assert_eq!(
            add(
                &dirs,
                NewTarget {
                    provider: "webhook".into(),
                    name: "Hook again".into(),
                    url: "https://example.com/hook".into(),
                    is_enabled: true,
                    events: vec![],
                },
            )
            .unwrap_err(),
            "A webhook with this URL is already configured."
        );
        let _ = std::fs::remove_dir_all(&dirs.root);
    }

    #[test]
    fn record_outcomes_updates_existing_and_skips_deleted() {
        let dirs = test_dirs("outcomes");
        let added = add(
            &dirs,
            NewTarget {
                provider: "slack".into(),
                name: "S".into(),
                url: "https://hooks.slack.com/services/T1/B1/y".into(),
                is_enabled: true,
                events: vec![],
            },
        )
        .unwrap();

        record_outcomes(
            &dirs,
            &[
                (added.id.clone(), Some("status 502".into())),
                ("deleted-id".into(), None),
            ],
        );
        let targets = load(&dirs).unwrap();
        assert_eq!(targets.len(), 1);
        assert!(targets[0].last_sent_at.is_some());
        assert_eq!(targets[0].last_error.as_deref(), Some("status 502"));

        // Success clears the error.
        record_outcomes(&dirs, &[(added.id.clone(), None)]);
        let targets = load(&dirs).unwrap();
        assert_eq!(targets[0].last_error, None);
        let _ = std::fs::remove_dir_all(&dirs.root);
    }
}
