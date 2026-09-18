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
    /// Read, never acted on. It told the desktop app whether to register a task that fires while
    /// logged out; a server is already running when the task is due, so there is no such choice
    /// to make. Kept because job files written by the desktop app carry it, and refusing to read
    /// them would lose the task.
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

fn default_max_run_seconds() -> u64 {
    DEFAULT_MAX_RUN_SECONDS
}

fn default_run_mode() -> String {
    "user".to_string()
}

/// The directory job files have always been filed under. The server runs rclone on its own
/// machine and nowhere else, so this is a fixed path segment, not a choice — but the layout is
/// shared with the desktop app, which does have more than one, so the segment stays.
pub const JOBS_DIR: &str = "local";

/// Job files under one directory of the jobs root. Only [`scheduler_unregister_all`] passes
/// anything but [`JOBS_DIR`], sweeping what an older multi-host install left behind.
///
/// [`scheduler_unregister_all`]: super::scheduler_unregister_all
pub fn jobs_dir_of(dirs: &DataDir, dir: &str) -> PathBuf {
    dirs.root.join("scheduler").join("jobs").join(dir)
}

pub fn jobs_dir(dirs: &DataDir) -> PathBuf {
    jobs_dir_of(dirs, JOBS_DIR)
}

pub fn job_path(dirs: &DataDir, task_id: &str) -> PathBuf {
    jobs_dir(dirs).join(format!("{}.json", task_id))
}

pub fn load(dirs: &DataDir, task_id: &str) -> Result<JobSpec, String> {
    let path = job_path(dirs, task_id);
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
    let target = jobs_dir(dirs).join(format!("{}.json", spec.task_id));
    let json = serde_json::to_string_pretty(spec).map_err(|e| e.to_string())?;
    crate::fsutil::write_atomic(&target, json.as_bytes())
        .map_err(|e| format!("failed to save job file: {}", e))
}

pub fn remove(dirs: &DataDir, task_id: &str) {
    remove_in(dirs, JOBS_DIR, task_id);
}

pub fn remove_in(dirs: &DataDir, host_dir: &str, task_id: &str) {
    let _ = std::fs::remove_file(jobs_dir_of(dirs, host_dir).join(format!("{}.json", task_id)));
}

/// Every registered job spec (unreadable files skipped with a log line).
pub fn list(dirs: &DataDir) -> Vec<JobSpec> {
    list_in(dirs, JOBS_DIR)
}

pub fn list_in(dirs: &DataDir, host_dir: &str) -> Vec<JobSpec> {
    let dir = jobs_dir_of(dirs, host_dir);
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
