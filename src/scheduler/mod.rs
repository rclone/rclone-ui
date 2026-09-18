//! Scheduled tasks, fired by the server itself.
//!
//! Registering a task writes a job file and an artifact for `ticker.rs`, the server's own minute
//! ticker; when one is due the ticker spawns this same binary headlessly (`run-task <id>`), which
//! executes the pre-serialized rclone requests stored in the job file. Nothing is registered with
//! the operating system, so there is no cron entry or Task Scheduler job to keep in step, and a
//! task fires whenever the server is running — which is what a server is for.
//!
//! `JobSpec.run_mode` survives as an ignored field: job files written by the desktop app carry
//! it, and refusing to read them would lose the task.

pub mod cronconv;
pub mod history;
pub mod jobfile;
pub mod runner;
pub mod storeread;
pub mod ticker;


use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use serde::Serialize;

use crate::ctx::Ctx;

use jobfile::JobSpec;
use storeread::DataDir;

/// `set_enabled` on a task that has no registration. The disable path in
/// `scheduler_set_enabled` treats it as benign — nothing armed IS disabled — and matches on this
/// exact string, so it must not be reworded in passing.
pub(crate) const NOT_REGISTERED: &str = "Task is not registered";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallState {
    NotInstalled,
    Installed { enabled: bool },
}

/// Everything the ticker needs to (re)create a task's registration: the schedule to match, the
/// child to spawn, and whether it is armed. The run's own limits live in the job file, which the
/// runner reads when it starts — nothing here has to carry them.
pub struct RenderedSchedule {
    pub cron: cronconv::CronSpec,
    pub program: PathBuf,
    pub args: Vec<String>,
    /// The state to install in, baked into the artifact so registration is one operation: a
    /// disabled task is never briefly armed between an install and a follow-up set_enabled, and a
    /// partial failure can't leave it running against the user's intent.
    pub enabled: bool,
}

/// A task the ticker holds, and whether it will fire.
#[derive(Debug, Clone, PartialEq)]
pub struct Registration {
    pub task_id: String,
    pub enabled: bool,
}

/// What the scheduler needs of its backend. One type implements it — [`ticker::TickerBackend`] —
/// and the seam is what keeps the registration store behind a contract rather than spread through
/// the functions below.
pub trait SchedulerBackend: Send + Sync {
    /// Create or overwrite the task's registration in `rendered.enabled`'s state. Idempotent.
    fn install(&self, task_id: &str, rendered: &RenderedSchedule) -> Result<(), String>;
    /// Remove the registration. Idempotent (a missing one is not an error).
    fn uninstall(&self, task_id: &str) -> Result<(), String>;
    fn set_enabled(&self, task_id: &str, enabled: bool) -> Result<(), String>;
    fn run_now(&self, task_id: &str) -> Result<(), String>;
    fn is_installed(&self, task_id: &str) -> Result<InstallState, String>;
    /// Everything of ours it holds, in one read. An error means it could not be inspected, and
    /// nothing may be concluded from it.
    fn inventory(&self) -> Result<Vec<Registration>, String>;
}

/// The backend: the in-process ticker. This server is a long-running daemon, so tasks fire from
/// its own minute loop and nothing is registered with the operating system.
pub fn backend(dirs: &DataDir) -> Result<Box<dyn SchedulerBackend>, String> {
    Ok(Box::new(ticker::TickerBackend::new(dirs)))
}

/// Serializes every scheduler mutation across the process. A registration is two writes — the
/// job file and the ticker's artifact — and the startup reconcile, a settings page and the
/// ticker's own sweep would otherwise interleave them, leaving a task with one and not the
/// other. Each run is covered separately by its own file lock (history::acquire_lock).
static MUTATION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn mutation_guard() -> std::sync::MutexGuard<'static, ()> {
    MUTATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Task ids become file names — never trust them,
/// even though the app generates UUIDs.
pub fn sanitize_id(task_id: &str) -> Result<String, String> {
    if task_id.is_empty() || task_id.len() > 64 {
        return Err("invalid task id".to_string());
    }
    if !task_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        || task_id.contains("..")
    {
        return Err("invalid task id".to_string());
    }
    Ok(task_id.to_string())
}

/// The path a registration invokes — stable across restarts and updates.
pub fn registered_invocation() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("cannot resolve app path: {}", e))
}

/// The GUI's resolved data directory, baked into every runner invocation (scheduled and "Run
/// now"): schedulers hand the runner a bare environment, so re-deriving it there silently
/// diverges when the session sets XDG_DATA_HOME (Linux) or the app runs with an overridden
/// directory — the runner would look elsewhere, find no job file, and treat a valid task as an
/// orphan.
pub(crate) fn data_dir_args(dirs: &DataDir) -> [String; 2] {
    [
        "--data-dir".to_string(),
        dirs.root.to_string_lossy().into_owned(),
    ]
}

fn render(dirs: &DataDir, spec: &JobSpec, enabled: bool) -> Result<RenderedSchedule, String> {
    let cron = cronconv::parse(&spec.cron)?;

    let mut args = Vec::new();
    let program = registered_invocation()?;
    args.extend(["run-task".to_string(), spec.task_id.clone()]);
    args.extend(data_dir_args(dirs));

    Ok(RenderedSchedule {
        cron,
        program,
        args,
        enabled,
    })
}

// ---------------------------------------------------------------------------
// Commands (declared in commands/mod.rs as `sync`: hosts run them on the blocking pool)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportInfo {
    pub supported: bool,
    pub reason: Option<String>,
}

pub fn scheduler_supported(ctx: &Ctx) -> Result<SupportInfo, String> {
    // On Flatpak, backend()→check_available() probes the host with a subprocess.
    Ok(match backend(&ctx.dirs) {
        Ok(_) => SupportInfo {
            supported: true,
            reason: None,
        },
        Err(reason) => SupportInfo {
            supported: false,
            reason: Some(reason),
        },
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronValidation {
    pub valid: bool,
    pub error: Option<String>,
    /// The next few local fire times (RFC3339 with offset), computed by the SAME matcher the
    /// runner uses. This is the UI's preview source — JS cron libraries disagree with Vixie
    /// cron on the dom/dow star flag, so predicting fires anywhere else risks showing runs the
    /// native schedule will never perform. Empty when invalid (or nothing fires within 5 years).
    pub next_runs: Vec<String>,
}

pub fn scheduler_validate_cron(_ctx: &Ctx, cron: String) -> Result<CronValidation, String> {
    Ok(match cronconv::validate(&cron) {
        Ok(()) => CronValidation {
            valid: true,
            error: None,
            next_runs: cronconv::parse(&cron)
                .map(|spec| cronconv::next_fires(&spec, chrono::Local::now(), 10))
                .unwrap_or_default(),
        },
        Err(error) => CronValidation {
            valid: false,
            error: Some(error),
            next_runs: Vec::new(),
        },
    })
}

/// UPSERT: write the job file and (re)install the registration in the given enabled state (one
/// operation — no separate set_enabled step to half-fail). There is one backend, the server's own
/// minute ticker, so nothing has to be uninstalled from another one first.
pub fn scheduler_register(ctx: &Ctx, spec: JobSpec, enabled: bool) -> Result<(), String> {
    let dirs = ctx.dirs.clone();

    sanitize_id(&spec.task_id)?;
    if spec.schema_version != jobfile::JOB_SCHEMA_VERSION {
        return Err(format!(
            "unsupported job schema version {}",
            spec.schema_version
        ));
    }
    if spec.requests.is_empty() {
        return Err("The task produced no rclone requests".to_string());
    }

    let _guard = mutation_guard();
    let backend = backend(&dirs)?;
    let rendered = render(&dirs, &spec, enabled)?;
    jobfile::save(&dirs, &spec)?;
    if let Err(e) = backend.install(&spec.task_id, &rendered) {
        // Keep the reported state truthful: "not registered" must mean nothing fires. The
        // old artifact would otherwise keep firing the OLD schedule against the NEW job
        // file. The job file stays for the startup reconcile to retry.
        let _ = backend.uninstall(&spec.task_id);
        return Err(e);
    }
    Ok(())
}

pub fn scheduler_unregister(ctx: &Ctx, task_id: String) -> Result<(), String> {
    let dirs = ctx.dirs.clone();
    let task_id = sanitize_id(&task_id)?;
    let _guard = mutation_guard();
    // The job file is removed even when the uninstall fails: a surviving registration self-heals
    // on its next fire (the runner finds no job file, removes it, and exits).
    let uninstall_result = match backend(&dirs) {
        Ok(backend) => backend.uninstall(&task_id),
        Err(e) => Err(e),
    };
    jobfile::remove(&dirs, &task_id);
    history::remove_all(&dirs, &task_id);
    uninstall_result
}

pub fn scheduler_set_enabled(ctx: &Ctx, task_id: String, enabled: bool) -> Result<(), String> {
    let dirs = ctx.dirs.clone();
    let task_id = sanitize_id(&task_id)?;
    let _guard = mutation_guard();
    let result = backend(&dirs)?.set_enabled(&task_id, enabled);

    // Disabling treats "no artifact" as success — nothing armed IS disabled — but never swallows
    // a real failure, which would leave the task firing while the UI says paused. Enabling keeps
    // the strict error: it must not guess.
    if !enabled {
        return match result {
            Err(e) if e == NOT_REGISTERED => Ok(()),
            other => other,
        };
    }
    result
}

pub fn scheduler_run_now(ctx: &Ctx, task_id: String) -> Result<(), String> {
    let dirs = ctx.dirs.clone();
    let task_id = sanitize_id(&task_id)?;
    backend(&dirs)?.run_now(&task_id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatus {
    pub task_id: String,
    pub installed: bool,
    pub enabled: bool,
    pub running: bool,
    pub last_finished: Option<serde_json::Value>,
    /// Why the task's state could not be established, when it could not be.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// What the ticker holds (task id → enabled), or why it could not be read.
type Inventory = Result<HashMap<String, bool>, String>;

fn take_inventory(dirs: &DataDir) -> Inventory {
    Ok(backend(dirs)?
        .inventory()?
        .into_iter()
        .map(|r| (r.task_id, r.enabled))
        .collect())
}

/// (installed, enabled, warning) for one task. A read failure is reported as such, never as
/// "not installed".
fn install_state_of(inventory: &Inventory, task_id: &str) -> (bool, bool, Option<String>) {
    match inventory {
        Ok(held) => match held.get(task_id) {
            Some(enabled) => (true, *enabled, None),
            None => (false, false, None),
        },
        Err(e) => (
            false,
            false,
            Some(format!("The schedules could not be read: {}", e)),
        ),
    }
}

pub fn scheduler_status(ctx: &Ctx) -> Result<Vec<TaskStatus>, String> {
    let dirs = ctx.dirs.clone();

    // What the ticker holds, read the first time a task needs it.
    let mut taken: Option<Inventory> = None;
    let mut statuses = Vec::new();
    for spec in jobfile::list(&dirs) {
        let inventory = taken.get_or_insert_with(|| take_inventory(&dirs));
        let (installed, enabled, warning) = install_state_of(inventory, &spec.task_id);

        let running = history::is_running(&dirs, &spec.task_id);
        let lines = history::read(&dirs, &spec.task_id, 20);
        let event_of = |line: &serde_json::Value| {
            line.get("event")
                .and_then(|e| e.as_str())
                .map(str::to_owned)
        };
        // Newest-first: the latest started/finished event is the latest ATTEMPT. A started
        // with no finished and no live lock is a run that died without writing its terminal
        // record (crash, SIGKILL, power loss, the run's own time limit) — surfacing the
        // older success (or "Never") instead would hide the interruption.
        let newest_attempt = lines.iter().find(|line| {
            matches!(
                event_of(line).as_deref(),
                Some("started") | Some("finished")
            )
        });
        let last_finished = match newest_attempt {
            Some(line) if event_of(line).as_deref() == Some("started") && !running => {
                Some(serde_json::json!({
                    "runId": line.get("runId").cloned().unwrap_or_default(),
                    "ts": line.get("ts").cloned().unwrap_or_default(),
                    "success": false,
                    "error": "The run was interrupted before it could finish (crash, forced shutdown, or power loss).",
                    "durationMs": 0,
                    "interrupted": true,
                }))
            }
            _ => lines
                .iter()
                .find(|line| event_of(line).as_deref() == Some("finished"))
                .cloned(),
        };
        statuses.push(TaskStatus {
            task_id: spec.task_id.clone(),
            installed,
            enabled,
            running,
            last_finished,
            warning,
        });
    }
    Ok(statuses)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogContent {
    pub content: String,
    pub truncated: bool,
}

/// Tail of a task's log for the in-app viewer. `which`: "runner" (our runner's lines) or
/// "daemon" (the transient rclone daemon's stderr).
pub fn scheduler_read_log(ctx: &Ctx, task_id: String, which: String) -> Result<LogContent, String> {
    const MAX_TAIL_BYTES: usize = 64 * 1024;

    let dirs = ctx.dirs.clone();
    let task_id = sanitize_id(&task_id)?;
    let path = match which.as_str() {
        "runner" => history::log_path(&dirs, &task_id),
        "daemon" => history::log_path(&dirs, &task_id).with_extension("daemon.log"),
        other => return Err(format!("unknown log '{}'", other)),
    };

    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(LogContent {
            content: String::new(),
            truncated: false,
        });
    };

    let truncated = bytes.len() > MAX_TAIL_BYTES;
    let tail = if truncated {
        let cut = bytes.len() - MAX_TAIL_BYTES;
        // Align to the next line boundary so the viewer never starts mid-line.
        let aligned = bytes[cut..]
            .iter()
            .position(|&b| b == b'\n')
            .map(|i| cut + i + 1)
            .unwrap_or(cut);
        &bytes[aligned..]
    } else {
        &bytes[..]
    };

    Ok(LogContent {
        content: String::from_utf8_lossy(tail).into_owned(),
        truncated,
    })
}

pub fn scheduler_read_history(
    ctx: &Ctx,
    task_id: String,
    limit: Option<usize>,
) -> Result<Vec<serde_json::Value>, String> {
    let dirs = ctx.dirs.clone();
    let task_id = sanitize_id(&task_id)?;
    Ok(history::read(&dirs, &task_id, limit.unwrap_or(50)))
}

/// Remove every registration this server ever made (Settings escape hatch / pre-uninstall
/// cleanup). Sweeps job files and orphaned registrations alike.
pub fn scheduler_unregister_all(ctx: &Ctx) -> Result<u32, String> {
    let dirs = ctx.dirs.clone();
    let _guard = mutation_guard();
    let backend = backend(&dirs).ok();
    let mut removed: u32 = 0;

    let jobs_root = dirs.root.join("scheduler").join("jobs");
    if let Ok(host_dirs) = std::fs::read_dir(&jobs_root) {
        for host_dir in host_dirs.flatten() {
            let host_dir = host_dir.file_name().to_string_lossy().to_string();
            for spec in jobfile::list_in(&dirs, &host_dir) {
                if backend
                    .as_ref()
                    .is_some_and(|b| b.uninstall(&spec.task_id).is_ok())
                {
                    removed += 1;
                }
                jobfile::remove_in(&dirs, &host_dir, &spec.task_id);
                history::remove_all(&dirs, &spec.task_id);
            }
        }
    }

    // Orphan sweep: artifacts whose job files were lost, across every backend.
    removed += sweep_orphans(&dirs);
    Ok(removed)
}

/// Task ids that still have a job file — by FILENAME, deliberately not by parse: an unreadable
/// or newer-schema job file is an environment problem, and sweeping its artifact would destroy
/// a valid registration (same conservatism as the runner's self-heal).
fn registered_task_ids(dirs: &DataDir) -> std::collections::HashSet<String> {
    let mut ids = std::collections::HashSet::new();
    let jobs_root = dirs.root.join("scheduler").join("jobs");
    let Ok(host_dirs) = std::fs::read_dir(&jobs_root) else {
        return ids;
    };
    for host_dir in host_dirs.flatten() {
        let Ok(entries) = std::fs::read_dir(host_dir.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(id) = name.strip_suffix(".json") {
                ids.insert(id.to_string());
            }
        }
    }
    ids
}

/// Sweep registrations that have NO job file. These leftovers appear when an uninstall fails
/// after the job file was removed; a DISABLED leftover never fires, so the runner's fire-time
/// self-heal can never reach it — this sweep is the only thing that does.
fn sweep_orphans(dirs: &DataDir) -> u32 {
    match backend(dirs) {
        Ok(backend) => sweep_backend(backend.as_ref(), &registered_task_ids(dirs)),
        Err(_) => 0,
    }
}

/// Uninstalls what the backend holds beyond `keep`. A backend that cannot be inspected is left
/// alone: a read failure never authorises a deletion.
pub(crate) fn sweep_backend(backend: &dyn SchedulerBackend, keep: &HashSet<String>) -> u32 {
    let Ok(registrations) = backend.inventory() else {
        return 0;
    };
    let mut removed = 0;
    for registration in registrations {
        let id = registration.task_id;
        if keep.contains(&id) || sanitize_id(&id).is_err() {
            continue;
        }
        if backend.uninstall(&id).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod inventory_tests {
    use super::*;

    /// A backend that cannot be read reports itself, rather than every task as "not installed".
    #[test]
    fn an_inspection_failure_is_a_warning_not_an_absence() {
        let failed: Inventory = Err("the ticker directory could not be read".into());
        let (installed, enabled, warning) = install_state_of(&failed, "t1");
        assert!(!installed && !enabled);
        assert!(warning
            .unwrap()
            .contains("the ticker directory could not be read"));
    }

    /// A backend that cannot be read keeps its registrations; nothing is swept on a guess.
    #[test]
    fn a_failed_inventory_sweeps_nothing() {
        struct Broken(std::sync::Mutex<u32>);
        impl SchedulerBackend for Broken {
            fn install(&self, _: &str, _: &RenderedSchedule) -> Result<(), String> {
                Ok(())
            }
            fn uninstall(&self, _: &str) -> Result<(), String> {
                *self.0.lock().unwrap() += 1;
                Ok(())
            }
            fn set_enabled(&self, _: &str, _: bool) -> Result<(), String> {
                Ok(())
            }
            fn run_now(&self, _: &str) -> Result<(), String> {
                Ok(())
            }
            fn is_installed(&self, _: &str) -> Result<InstallState, String> {
                Ok(InstallState::NotInstalled)
            }
            fn inventory(&self) -> Result<Vec<Registration>, String> {
                Err("service unavailable".into())
            }
        }
        assert_eq!(
            sweep_backend(&Broken(std::sync::Mutex::new(0)), &HashSet::new()),
            0
        );
    }
}

/// Startup-reconcile hook for the sweep above. Runs AFTER the reconcile has re-registered every
/// stored task (their job files then exist and protect their registrations).
pub fn scheduler_sweep_orphans(ctx: &Ctx) -> Result<u32, String> {
    let dirs = ctx.dirs.clone();
    let _guard = mutation_guard();
    Ok(sweep_orphans(&dirs))
}
