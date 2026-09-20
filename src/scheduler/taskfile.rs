//! The per-task file: the whole of a schedule, owned by the server (`scheduler/tasks/<id>.json`).
//! `task` is the page's form (name, operation, cron, args, kinds, maxRunHours): what the page
//! shows and edits, opaque here. `spec` is what a run executes, built from that form by the
//! page's request builders when the task was saved. Nothing here says which rclone or which
//! config: a run goes to the daemon the server is already running, and so uses whatever that one
//! was started with. Nor is any other dynamic state stored (passwords, proxy, webhook targets):
//! it is resolved when it is needed, so it never goes stale.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::datadir::DataDir;

pub const SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_MAX_RUN_SECONDS: u64 = 86_400;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RcRequest {
    /// e.g. "/job/batch", "/sync/sync", "/sync/bisync" — what a run submits, through the
    /// transfer service, to the daemon the server is running.
    pub endpoint: String,
    /// JSON body. The TS serializer folds what were query params into the body and always sets
    /// `_async: true`; rclone's RC treats query and body parameters identically.
    pub body: Value,
}

/// What a run executes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSpec {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFile {
    pub schema_version: u32,
    pub id: String,
    pub enabled: bool,
    /// When the task was first saved (ms since the epoch): the order the page lists in. The
    /// server sets it; a page's value is ignored.
    #[serde(default)]
    pub created_at: Option<u64>,
    /// The page's form, kept whole for it.
    pub task: Value,
    pub spec: JobSpec,
}

pub fn tasks_dir(dirs: &DataDir) -> PathBuf {
    dirs.root.join("scheduler").join("tasks")
}

pub fn path(dirs: &DataDir, id: &str) -> PathBuf {
    tasks_dir(dirs).join(format!("{}.json", id))
}

fn decode(raw: &str) -> Result<TaskFile, String> {
    let file: TaskFile =
        serde_json::from_str(raw).map_err(|e| format!("invalid task file: {}", e))?;
    if file.schema_version > SCHEMA_VERSION {
        return Err(format!(
            "task file schema {} is newer than this server supports ({})",
            file.schema_version, SCHEMA_VERSION
        ));
    }
    Ok(file)
}

/// `None` when there is no such task; an error for a file that is there but cannot be read.
pub fn load(dirs: &DataDir, id: &str) -> Result<Option<TaskFile>, String> {
    let path = path(dirs, id);
    match std::fs::read_to_string(&path) {
        Ok(raw) => decode(&raw).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("failed to read task file {}: {}", path.display(), e)),
    }
}

/// Atomic write: temp file in the same directory, then rename over the target.
pub fn save(dirs: &DataDir, file: &TaskFile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    crate::fsutil::write_atomic(&path(dirs, &file.id), json.as_bytes())
        .map_err(|e| format!("failed to save task file: {}", e))
}

pub fn remove(dirs: &DataDir, id: &str) {
    let _ = std::fs::remove_file(path(dirs, id));
}

/// Every task, oldest first (unreadable files skipped with a log line).
pub fn list(dirs: &DataDir) -> Vec<TaskFile> {
    let Ok(entries) = std::fs::read_dir(tasks_dir(dirs)) else {
        return Vec::new();
    };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|raw| decode(&raw))
        {
            Ok(file) => files.push(file),
            Err(e) => log::warn!("skipping unreadable task file {}: {}", path.display(), e),
        }
    }
    files.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
    files
}
