//! The per-task job file: the static definition a run executes.
//!
//! Written only by the `scheduler_register` command (atomic temp+rename); read by the runner and
//! by `scheduler_status`. Nothing here says which rclone or which config: a run goes to the
//! daemon the server is already running, and so uses whatever that one was started with. Nor is
//! any other dynamic state stored (passwords, proxy, webhook targets) — it is resolved at the
//! moment it is needed, so it never goes stale.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::storeread::DataDir;

pub const JOB_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_MAX_RUN_SECONDS: u64 = 86_400;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RcRequest {
    /// e.g. "/job/batch", "/sync/sync", "/sync/bisync" — what a run submits, through the
    /// transfer service, to the daemon the server is running.
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
    #[serde(default = "default_max_run_seconds")]
    pub max_run_seconds: u64,
    /// What the task runs on, as the page shows it, for the transfer each run records.
    pub sources: Vec<String>,
    #[serde(default)]
    pub destination: Option<String>,
    pub requests: Vec<RcRequest>,
}

fn default_max_run_seconds() -> u64 {
    DEFAULT_MAX_RUN_SECONDS
}

pub fn jobs_dir(dirs: &DataDir) -> PathBuf {
    dirs.root.join("scheduler").join("jobs")
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
    let _ = std::fs::remove_file(job_path(dirs, task_id));
}

/// Every registered job spec (unreadable files skipped with a log line).
pub fn list(dirs: &DataDir) -> Vec<JobSpec> {
    let dir = jobs_dir(dirs);
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
