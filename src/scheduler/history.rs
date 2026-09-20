//! Run history (append-only JSONL per task) and the runner's log file.
//!
//! The runner writes both and the pages only read them. History is what a page asks for a
//! schedule's last result, in place of store fields two writers would have raced over.
//!
//! One run of a schedule at a time is a set in memory ([`super::runner::is_running`]): a run is a
//! task on the server's own runtime, so there is no second process to keep out.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::storeread::DataDir;

const HISTORY_ROTATE_BYTES: u64 = 512 * 1024;
const HISTORY_KEEP_LINES: usize = 200;
const LOG_ROTATE_BYTES: u64 = 1024 * 1024;

pub fn history_path(dirs: &DataDir, task_id: &str) -> PathBuf {
    dirs.root
        .join("scheduler")
        .join("history")
        .join(format!("{}.jsonl", task_id))
}

pub fn log_path(dirs: &DataDir, task_id: &str) -> PathBuf {
    dirs.root
        .join("scheduler")
        .join("logs")
        .join(format!("{}.log", task_id))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "lowercase")]
pub enum HistoryLine {
    Started {
        #[serde(rename = "runId")]
        run_id: String,
        ts: String,
    },
    Finished {
        #[serde(rename = "runId")]
        run_id: String,
        ts: String,
        success: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(rename = "durationMs")]
        duration_ms: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        jobids: Option<Vec<i64>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stats: Option<serde_json::Value>,
    },
    Skipped {
        ts: String,
        reason: String,
    },
}

pub fn append(dirs: &DataDir, task_id: &str, line: &HistoryLine) {
    let path = history_path(dirs, task_id);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    rotate_history_if_needed(&path);
    let Ok(json) = serde_json::to_string(line) else {
        return;
    };
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{}", json);
        // fsync: a run that already had external effects must not lose its record to a crash
        // or power loss right after finishing.
        let _ = file.sync_all();
    }
}

fn rotate_history_if_needed(path: &PathBuf) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.len() <= HISTORY_ROTATE_BYTES {
        return;
    }
    if let Ok(content) = std::fs::read_to_string(path) {
        let lines: Vec<&str> = content.lines().collect();
        let keep = lines.len().saturating_sub(HISTORY_KEEP_LINES);
        let trimmed = lines[keep..].join("\n");
        let _ = std::fs::write(path, format!("{}\n", trimmed));
    }
}

/// Last `limit` parsed lines, newest first. Unparseable lines are skipped.
pub fn read(dirs: &DataDir, task_id: &str, limit: usize) -> Vec<serde_json::Value> {
    let path = history_path(dirs, task_id);
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    content
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .take(limit)
        .collect()
}

/// Simple appending logger for the runner, rotated at 1 MB.
pub struct RunLog {
    file: Option<std::fs::File>,
}

impl RunLog {
    pub fn open(dirs: &DataDir, task_id: &str) -> Self {
        let path = log_path(dirs, task_id);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > LOG_ROTATE_BYTES {
                let _ = std::fs::rename(&path, path.with_extension("log.old"));
            }
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok();
        Self { file }
    }

    pub fn line(&mut self, message: &str) {
        if let Some(file) = &mut self.file {
            let _ = writeln!(file, "[{}] {}", crate::time::now_iso(), message);
        }
    }
}

pub fn remove_all(dirs: &DataDir, task_id: &str) {
    let _ = std::fs::remove_file(history_path(dirs, task_id));
    let _ = std::fs::remove_file(log_path(dirs, task_id));
    let _ = std::fs::remove_file(log_path(dirs, task_id).with_extension("log.old"));
}
