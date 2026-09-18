//! The per-task job file: the static definition the headless runner executes.
//!
//! Written only by the `scheduler_register` command (atomic temp+rename); read by the runner and
//! by `scheduler_status`. Dynamic state (passwords, proxy, webhook targets) is deliberately NOT
//! stored here — the runner resolves it live from the app stores so it never goes stale.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::storeread::DataDir;

pub const JOB_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_MAX_RUN_SECONDS: u64 = 86_400;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RcRequest {
    /// e.g. "/job/batch", "/sync/sync", "/sync/bisync" — POSTed to the transient daemon.
    pub endpoint: String,
    /// JSON body. The TS serializer folds what were query params into the body and always sets
    /// `_async: true`; rclone's RC treats query and body parameters identically.
    pub body: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSpec {
    pub schema_version: u32,
    pub task_id: String,
    pub host_id: String,
    pub name: String,
    pub operation: String,
    pub cron: String,
    pub config_id: String,
    /// "app-default" or an absolute path to a specific rclone binary.
    pub binary: String,
    #[serde(default = "default_max_run_seconds")]
    pub max_run_seconds: u64,
    /// Raise the transient daemon to INFO logging (per-transfer lines in the daemon log).
    #[serde(default)]
    pub verbose_logging: bool,
    /// "user" (the default): only runs while the user is logged in — on Unix the runner gates on
    /// an active session and borrows its context; on Windows the task uses the interactive logon
    /// type. "system": runs even while logged out, but outside the login session (no OS keychain,
    /// session-mounted drives, and on macOS cron's TCC attribution for protected folders).
    /// Absent field = "user": the legacy in-app scheduler only ever ran inside the app session,
    /// so migrated tasks keep their effective semantics.
    #[serde(default = "default_run_mode")]
    pub run_mode: String,
    /// What the task runs on, as the page shows it, for the transfer each run records. Absent
    /// in job files written before transfers were recorded; the runner then reads the paths
    /// off the requests.
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default)]
    pub destination: Option<String>,
    pub requests: Vec<RcRequest>,
}

impl JobSpec {
    /// Anything that isn't explicitly "system" runs in user mode (the default, and the safer
    /// interpretation for unknown values — it skips logged-out fires instead of failing them).
    pub fn is_user_mode(&self) -> bool {
        self.run_mode != "system"
    }
}

fn default_max_run_seconds() -> u64 {
    DEFAULT_MAX_RUN_SECONDS
}

fn default_run_mode() -> String {
    "user".to_string()
}

pub fn jobs_dir(dirs: &DataDir, host_id: &str) -> PathBuf {
    dirs.root.join("scheduler").join("jobs").join(host_id)
}

pub fn job_path(dirs: &DataDir, host_id: &str, task_id: &str) -> PathBuf {
    jobs_dir(dirs, host_id).join(format!("{}.json", task_id))
}

pub fn load(dirs: &DataDir, host_id: &str, task_id: &str) -> Result<JobSpec, String> {
    let path = job_path(dirs, host_id, task_id);
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("failed to read job file {}: {}", path.display(), e))?;
    let spec: JobSpec =
        serde_json::from_str(&raw).map_err(|e| format!("invalid job file: {}", e))?;
    if spec.schema_version > JOB_SCHEMA_VERSION {
        return Err(format!(
            "job file schema {} is newer than this app supports ({})",
            spec.schema_version, JOB_SCHEMA_VERSION
        ));
    }
    Ok(spec)
}

/// Atomic write: temp file in the same directory, then rename over the target.
pub fn save(dirs: &DataDir, spec: &JobSpec) -> Result<(), String> {
    let target = jobs_dir(dirs, &spec.host_id).join(format!("{}.json", spec.task_id));
    let json = serde_json::to_string_pretty(spec).map_err(|e| e.to_string())?;
    crate::fsutil::write_atomic(&target, json.as_bytes())
        .map_err(|e| format!("failed to save job file: {}", e))
}

pub fn remove(dirs: &DataDir, host_id: &str, task_id: &str) {
    let _ = std::fs::remove_file(job_path(dirs, host_id, task_id));
}

/// All job specs registered for a host (unreadable files skipped with a log line).
pub fn list(dirs: &DataDir, host_id: &str) -> Vec<JobSpec> {
    let dir = jobs_dir(dirs, host_id);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut specs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|raw| serde_json::from_str::<JobSpec>(&raw).map_err(|e| e.to_string()))
        {
            Ok(spec) => specs.push(spec),
            Err(e) => log::warn!("skipping unreadable job file {}: {}", path.display(), e),
        }
    }
    specs
}
