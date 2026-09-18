//! Run history (append-only JSONL per task), run locks, and runner log files.
//!
//! The runner is the only writer of a task's history/lock/log; the GUI only reads. History
//! replaces the old zustand isRunning/lastRun/lastRunError fields, which avoids concurrent
//! writes to the store file from two processes.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

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

pub fn lock_path(dirs: &DataDir, task_id: &str) -> PathBuf {
    dirs.root
        .join("scheduler")
        .join("locks")
        .join(format!("{}.lock", task_id))
}

pub fn log_path(dirs: &DataDir, task_id: &str) -> PathBuf {
    dirs.root
        .join("scheduler")
        .join("logs")
        .join(format!("{}.log", task_id))
}

pub fn now_iso() -> String {
    // RFC3339 UTC with millisecond precision, no chrono dependency.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let days = secs / 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    let rem = secs % 86_400;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year,
        month,
        day,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        millis
    )
}

// Howard Hinnant's civil-from-days algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "lowercase")]
pub enum HistoryLine {
    Started {
        #[serde(rename = "runId")]
        run_id: String,
        ts: String,
        pid: u32,
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockInfo {
    pub pid: u32,
    pub started_at_ms: u64,
    /// Process name of the lock holder — guards liveness checks against pid reuse after a
    /// crash/reboot (a recycled pid would otherwise keep the task "running" for 24h).
    #[serde(default)]
    pub process_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daemon_pid: Option<u32>,
    /// OS start time (seconds since epoch) of the recorded daemon process. Identifies the
    /// process GENERATION: a recycled pid — which could be anything, including the GUI's own
    /// rclone daemon — never matches, and a custom-named rclone binary still does.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daemon_start_time: Option<u64>,
}

fn current_process_name() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default()
}

/// True when `pid` is alive AND (when recorded) still runs under the recorded process name.
/// Windows-only: on Unix the flock IS the liveness check (and pids are meaningless across
/// Flatpak sandbox PID namespaces anyway).
#[cfg(not(unix))]
fn pid_is_this_holder(pid: u32, expected_name: &str) -> bool {
    let pid = sysinfo::Pid::from_u32(pid);
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    let Some(process) = system.process(pid) else {
        return false;
    };
    if expected_name.is_empty() {
        return true; // pre-identity lock file: fall back to bare liveness
    }
    process.name().to_string_lossy() == expected_name
}

/// Leftover transient daemon cleanup of last resort: kill the recorded daemon pid, but only
/// after verifying it is still OUR process. The recorded OS start time identifies the process
/// generation exactly (±2s for clock rounding) — a recycled pid never matches, and custom-named
/// rclone binaries are still covered. Locks written before the start-time field fall back to
/// the old name check (which refuses custom names and, in the worst pid-reuse case, could match
/// an unrelated rclone — acceptable only for that legacy window).
fn kill_stale_daemon(info: &LockInfo) {
    let Some(daemon_pid) = info.daemon_pid else {
        return;
    };
    let pid = sysinfo::Pid::from_u32(daemon_pid);
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    let Some(proc_) = sys.process(pid) else {
        return;
    };
    let is_ours = match info.daemon_start_time {
        Some(recorded) => proc_.start_time().abs_diff(recorded) <= 2,
        None => {
            let name = proc_.name().to_string_lossy().to_lowercase();
            name == "rclone" || name == "rclone.exe"
        }
    };
    if is_ours {
        proc_.kill();
    }
}

pub enum LockResult {
    Acquired(RunLock),
    Held,
}

/// The held run lock. On Unix it owns the flock'd file handle: the kernel releases the lock the
/// moment the holder dies (crash-safe, no stale heuristics) and the lock is visible across
/// Flatpak sandboxes, whose separate PID namespaces make pid-liveness checks meaningless there
/// (a namespace-local pid from another sandbox is unfindable — or worse, matches an unrelated
/// process). On Windows the lock file's existence plus pid checks remain the mechanism.
pub struct RunLock {
    #[cfg(unix)]
    file: std::fs::File,
    #[cfg(not(unix))]
    path: PathBuf,
}

impl RunLock {
    pub fn release(self) {
        #[cfg(unix)]
        {
            // Truncate (a clean end must not leave daemon info for the next acquire to "reap")
            // and let the flock drop with the fd. The file itself stays: unlinking would open an
            // unlink/recreate race where two runners hold locks on two inodes of the same path.
            let _ = self.file.set_len(0);
        }
        #[cfg(not(unix))]
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn lock_info_now() -> LockInfo {
    LockInfo {
        pid: std::process::id(),
        started_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        process_name: current_process_name(),
        daemon_pid: None,
        daemon_start_time: None,
    }
}

/// Try to take the run lock.
///
/// Unix: an exclusive flock held for the runner's lifetime. Non-empty leftover content means the
/// previous run crashed without releasing (clean release truncates) — its recorded transient
/// daemon is reaped first. `max_run_seconds` is unused here: a hung (not crashed) runner keeps
/// the flock, and its own deadline/SIGTERM handling is what unwedges it.
#[cfg(unix)]
pub fn acquire_lock(
    dirs: &DataDir,
    task_id: &str,
    max_run_seconds: u64,
) -> Result<LockResult, String> {
    use std::os::unix::io::AsRawFd;
    let _ = max_run_seconds;

    let path = lock_path(dirs, task_id);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // Two attempts with a pause: the GUI's is_running probe holds a shared lock for
    // microseconds and must not turn a real fire into an "already-running" skip.
    for attempt in 0..2 {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|e| format!("failed to create lock file: {}", e))?;
        let locked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
        if locked {
            if let Ok(raw) = std::fs::read_to_string(&path) {
                if !raw.trim().is_empty() {
                    log::warn!(
                        "task {} lock was left by a crashed run — cleaning up",
                        task_id
                    );
                    if let Ok(stale) = serde_json::from_str::<LockInfo>(&raw) {
                        kill_stale_daemon(&stale);
                    }
                }
            }
            file.set_len(0)
                .map_err(|e| format!("failed to write lock file: {}", e))?;
            (&file)
                .write_all(
                    serde_json::to_string(&lock_info_now())
                        .unwrap_or_default()
                        .as_bytes(),
                )
                .map_err(|e| format!("failed to write lock file: {}", e))?;
            return Ok(LockResult::Acquired(RunLock { file }));
        }
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() != Some(libc::EWOULDBLOCK) {
            return Err(format!("failed to lock {}: {}", path.display(), err));
        }
        if attempt == 0 {
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    }
    Ok(LockResult::Held)
}

/// Windows: lock-file existence with pid+name liveness. A stale lock (dead/renamed pid, or older
/// than max_run_seconds + 5 min) is broken; any recorded transient daemon still alive AND named
/// rclone is killed first.
#[cfg(not(unix))]
pub fn acquire_lock(
    dirs: &DataDir,
    task_id: &str,
    max_run_seconds: u64,
) -> Result<LockResult, String> {
    let path = lock_path(dirs, task_id);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    for attempt in 0..2 {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let _ = file.write_all(
                    serde_json::to_string(&lock_info_now())
                        .unwrap_or_default()
                        .as_bytes(),
                );
                return Ok(LockResult::Acquired(RunLock { path }));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if attempt > 0 {
                    return Ok(LockResult::Held);
                }
                if !is_lock_stale(&path, max_run_seconds) {
                    return Ok(LockResult::Held);
                }
                log::warn!("breaking stale lock for task {}", task_id);
                let _ = std::fs::remove_file(&path);
            }
            Err(e) => return Err(format!("failed to create lock file: {}", e)),
        }
    }
    Ok(LockResult::Held)
}

#[cfg(not(unix))]
fn is_lock_stale(path: &PathBuf, max_run_seconds: u64) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return true; // unreadable lock = stale
    };
    let Ok(info) = serde_json::from_str::<LockInfo>(&raw) else {
        return true;
    };

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let expired = now_ms.saturating_sub(info.started_at_ms) > (max_run_seconds + 300) * 1000;

    if pid_is_this_holder(info.pid, &info.process_name) && !expired {
        return false;
    }

    kill_stale_daemon(&info);
    true
}

/// Record the transient daemon's pid (and its OS start time, the pid-reuse-proof identity for
/// later cleanup) into the held lock. Best effort.
pub fn record_daemon_pid(dirs: &DataDir, task_id: &str, daemon_pid: u32) {
    let path = lock_path(dirs, task_id);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(mut info) = serde_json::from_str::<LockInfo>(&raw) else {
        return;
    };
    info.daemon_pid = Some(daemon_pid);
    let pid = sysinfo::Pid::from_u32(daemon_pid);
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    info.daemon_start_time = sys.process(pid).map(|p| p.start_time());
    let _ = std::fs::write(&path, serde_json::to_string(&info).unwrap_or_default());
}

/// Whether a live run currently holds the lock. Unix: a shared-lock probe — it fails
/// (EWOULDBLOCK) exactly while a runner holds the exclusive flock, and works across Flatpak
/// sandboxes where pid checks cannot. The probe's own momentary lock drops with the fd.
#[cfg(unix)]
pub fn is_running(dirs: &DataDir, task_id: &str) -> bool {
    use std::os::unix::io::AsRawFd;
    let Ok(file) = OpenOptions::new().read(true).open(lock_path(dirs, task_id)) else {
        return false;
    };
    let free = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) } == 0;
    !free && std::io::Error::last_os_error().raw_os_error() == Some(libc::EWOULDBLOCK)
}

/// Whether a live run currently holds the lock (Windows: pid+name liveness).
#[cfg(not(unix))]
pub fn is_running(dirs: &DataDir, task_id: &str) -> bool {
    let path = lock_path(dirs, task_id);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return false;
    };
    let Ok(info) = serde_json::from_str::<LockInfo>(&raw) else {
        return false;
    };
    pid_is_this_holder(info.pid, &info.process_name)
}

/// Rename `path` to `.old` when it exceeds `max_bytes` (single-generation rotation).
pub fn rotate_file(path: &PathBuf, max_bytes: u64) {
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > max_bytes {
            let mut old = path.as_os_str().to_owned();
            old.push(".old");
            let _ = std::fs::rename(path, std::path::PathBuf::from(old));
        }
    }
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
            let _ = writeln!(file, "[{}] {}", now_iso(), message);
        }
    }
}

pub fn remove_all(dirs: &DataDir, task_id: &str) {
    let _ = std::fs::remove_file(history_path(dirs, task_id));
    let _ = std::fs::remove_file(lock_path(dirs, task_id));
    let _ = std::fs::remove_file(log_path(dirs, task_id));
    let _ = std::fs::remove_file(log_path(dirs, task_id).with_extension("log.old"));
    // The runner also writes the transient daemon's stderr to `<task>.daemon.log`
    // (rotated to `.daemon.log.old`); remove both so unregistering leaves nothing behind.
    let _ = std::fs::remove_file(log_path(dirs, task_id).with_extension("daemon.log"));
    let _ = std::fs::remove_file(log_path(dirs, task_id).with_extension("daemon.log.old"));
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn test_dirs(tag: &str) -> DataDir {
        // The pid: two test processes at once must not share (and sweep) one directory.
        let root =
            std::env::temp_dir().join(format!("rcloneui-lock-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        DataDir { root }
    }

    #[test]
    fn flock_mutual_exclusion_probe_and_crash_release() {
        let dirs = test_dirs("flock");
        let task = "t1";

        // Free → acquired; the GUI probe must see it as running while held.
        let lock = match acquire_lock(&dirs, task, 60).unwrap() {
            LockResult::Acquired(lock) => lock,
            LockResult::Held => panic!("fresh lock reported held"),
        };
        assert!(is_running(&dirs, task), "probe sees the held lock");

        // A second open+flock (even in the same process — flock is per open-file-description)
        // must report Held, not break the live lock like the old pid heuristics could.
        assert!(matches!(
            acquire_lock(&dirs, task, 60).unwrap(),
            LockResult::Held
        ));

        // Clean release: probe clears, file stays (truncated), re-acquire works.
        lock.release();
        assert!(!is_running(&dirs, task));
        assert!(
            lock_path(&dirs, task).exists(),
            "release truncates, never unlinks"
        );
        assert_eq!(std::fs::read(lock_path(&dirs, task)).unwrap(), b"");

        // Crash: dropping without release leaves content behind but the kernel frees the lock —
        // the next acquire must succeed on its own, with no staleness heuristics.
        let crashed = match acquire_lock(&dirs, task, 60).unwrap() {
            LockResult::Acquired(lock) => lock,
            LockResult::Held => panic!("re-acquire after release failed"),
        };
        drop(crashed);
        assert!(!is_running(&dirs, task), "kernel released the crashed lock");
        assert!(
            !std::fs::read(lock_path(&dirs, task)).unwrap().is_empty(),
            "crashed run leaves its record for daemon cleanup"
        );
        assert!(matches!(
            acquire_lock(&dirs, task, 60).unwrap(),
            LockResult::Acquired(_)
        ));

        let _ = std::fs::remove_dir_all(&dirs.root);
    }
}
