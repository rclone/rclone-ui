//! OS-native scheduling for Rclone UI's scheduled tasks.
//!
//! The GUI registers each task with the platform scheduler (the user's crontab on macOS/Linux,
//! Task Scheduler on Windows); the OS invokes this same binary headlessly (`run-task <id>`),
//! which executes the pre-serialized rclone requests stored in the task's job file. Whether a
//! task runs while logged out depends on its run mode: "user" (the default) only fires while the
//! user is logged in; "system" fires whether or not the user is logged in (cron daemon / S4U).
//!
//! Under Flatpak, scheduling works only when the user has granted host-spawn access
//! (`--talk-name=org.freedesktop.Flatpak`): the crontab commands run on the host via
//! `flatpak-spawn --host`, and the cron entry re-launches the app with `flatpak run … run-task`.

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

/// The one cross-backend error sentinel: `set_enabled` on a task with no OS artifact. The
/// disable path in `scheduler_set_enabled` treats it as benign (nothing armed IS disabled), so
/// every backend must return exactly this — schtasks in particular can't rely on its localized
/// /Change stderr and prechecks with its locale-invariant query instead.
pub(crate) const NOT_REGISTERED: &str = "Task is not registered";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallState {
    NotInstalled,
    Installed { enabled: bool },
}

/// Everything a backend needs to (re)create the OS artifact for a task.
pub struct RenderedSchedule {
    pub cron: cronconv::CronSpec,
    pub program: PathBuf,
    pub args: Vec<String>,
    /// The task's friendly name. Only the Windows backend has somewhere to put it (the schtasks
    /// XML `<Description>`); launchd identifies by Label = task id and crontab by a marker comment,
    /// so neither reads it — hence the cfg-gated allow.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub display_name: String,
    /// User-mode task (the default): only runs while the user is logged in. Only the Windows
    /// backend reads this — it bakes the mode into a single artifact (InteractiveToken vs S4U).
    /// On macOS the mode already picked the backend (launchd vs crontab) before rendering, and on
    /// Linux the crontab entry is identical for both modes (the runner gates/borrows the session
    /// at fire time from the job file). Hence the cfg-gated allow off Windows.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub user_mode: bool,
    /// The state to install in. Baked into the artifact (crontab `#off#` prefix, launchd
    /// active-vs-parked location, schtasks Settings `<Enabled>`) so registration is one
    /// operation: a disabled task is never briefly armed between an install and a follow-up
    /// set_enabled, and a partial failure can't leave it running against the user's intent.
    pub enabled: bool,
    /// The task's max run time. Only the Windows backend reads it (schtasks
    /// `<ExecutionTimeLimit>` must sit above the runner's own deadline or Task Scheduler kills
    /// the run first); cron/launchd don't supervise run durations — the runner's deadline is the
    /// only limit there.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub max_run_seconds: u64,
}

/// A task the backend holds: whether it will fire, and whether this profile made it (Windows
/// checks its definition; the other backends' namespaces are per user).
#[derive(Debug, Clone, PartialEq)]
pub struct Registration {
    pub task_id: String,
    pub enabled: bool,
    pub owned: bool,
}

pub trait SchedulerBackend: Send + Sync {
    /// Create or overwrite the OS artifact in `rendered.enabled`'s state. Idempotent.
    fn install(&self, task_id: &str, rendered: &RenderedSchedule) -> Result<(), String>;
    /// Remove the OS artifact. Idempotent (missing artifacts are not an error).
    fn uninstall(&self, task_id: &str) -> Result<(), String>;
    fn set_enabled(&self, task_id: &str, enabled: bool) -> Result<(), String>;
    fn run_now(&self, task_id: &str) -> Result<(), String>;
    fn is_installed(&self, task_id: &str) -> Result<InstallState, String>;
    /// Everything of ours the backend holds, in one go (cron: one crontab read; launchd: its
    /// two folders; Windows: one listing and each task's definition). An error means the
    /// backend could not be inspected, and nothing may be concluded from it.
    fn inventory(&self) -> Result<Vec<Registration>, String>;
    /// A user-visible reason the task won't fire even though it is installed and enabled —
    /// state the backend's own enabled model cannot see (macOS: the background item toggled off
    /// in System Settings unloads the agent while the plist stays in LaunchAgents). None = healthy.
    fn health_warning(&self, _task_id: &str) -> Option<String> {
        None
    }
}

/// The one backend: the in-process ticker. This server is a long-running daemon (a container
/// may have no cron at all), so tasks fire from its own minute loop.
pub fn backend(dirs: &DataDir) -> Result<Box<dyn SchedulerBackend>, String> {
    Ok(Box::new(ticker::TickerBackend::new(dirs)))
}

/// Serializes every scheduler mutation across the process. The hidden main window's startup
/// reconcile and an edit from the Settings webview otherwise interleave their whole-crontab
/// read-modify-write and silently drop each other's entry (healed only at the next reconcile).
/// The runner process is covered separately by the crontab file lock (crontab.rs).
static MUTATION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn mutation_guard() -> std::sync::MutexGuard<'static, ()> {
    MUTATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Every backend a task could be registered in — used for teardown (unregister, orphan sweep).
fn all_backends(dirs: &DataDir) -> Vec<Box<dyn SchedulerBackend>> {
    match backend(dirs) {
        Ok(b) => vec![b],
        Err(_) => Vec::new(),
    }
}

/// Task ids become crontab markers, schtasks task names, and file names — never trust them,
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

/// The path the OS scheduler should invoke — stable across app restarts and updates.
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
    args.extend([
        "run-task".to_string(),
        spec.task_id.clone(),
        "--host".to_string(),
        spec.host_id.clone(),
    ]);
    args.extend(data_dir_args(dirs));

    Ok(RenderedSchedule {
        cron,
        program,
        args,
        display_name: spec.name.clone(),
        user_mode: spec.is_user_mode(),
        enabled,
        max_run_seconds: spec.max_run_seconds,
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

/// UPSERT: write the job file and (re)install the OS artifact in the given enabled state (one
/// operation — no separate set_enabled step to half-fail). The backend depends on the run mode
/// (macOS user → launchd, else crontab/schtasks); a mode flip first uninstalls the old artifact
/// from the other backend so the task never fires twice.
pub fn scheduler_register(ctx: &Ctx, spec: JobSpec, enabled: bool) -> Result<(), String> {
    let dirs = ctx.dirs.clone();

    sanitize_id(&spec.task_id)?;
    sanitize_id(&spec.host_id)?;
    if spec.schema_version != jobfile::JOB_SCHEMA_VERSION {
        return Err(format!(
            "unsupported job schema version {}",
            spec.schema_version
        ));
    }
    if spec.host_id != "local" {
        return Err("Scheduling is only supported for the local host".to_string());
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

pub fn scheduler_unregister(ctx: &Ctx, task_id: String, host_id: String) -> Result<(), String> {
    let dirs = ctx.dirs.clone();
    let task_id = sanitize_id(&task_id)?;
    let host_id = sanitize_id(&host_id)?;
    let _guard = mutation_guard();
    // Uninstall from every backend (macOS covers both launchd and crontab) so the task is
    // removed regardless of the mode it was registered under. The job file is removed even
    // when an OS-level uninstall fails: a surviving trigger self-heals on its next fire (the
    // runner finds no job file, removes the trigger, and exits).
    let mut uninstall_result = Ok(());
    for backend in all_backends(&dirs) {
        if let Err(e) = backend.uninstall(&task_id) {
            uninstall_result = Err(e);
        }
    }
    jobfile::remove(&dirs, &host_id, &task_id);
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
    /// Backend health warning (see `SchedulerBackend::health_warning`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// A backend and what it holds (task id → enabled), or why it could not be inspected.
type Inventory = Result<(Box<dyn SchedulerBackend>, HashMap<String, bool>), String>;

fn take_inventory(dirs: &DataDir) -> Inventory {
    let backend = backend(dirs)?;
    let held = backend
        .inventory()?
        .into_iter()
        .map(|r| (r.task_id, r.enabled))
        .collect();
    Ok((backend, held))
}

/// (installed, enabled, warning) for one task from its backend's inventory. An inspection
/// failure is reported as such, never as "not installed".
fn install_state_of(inventory: &Inventory, task_id: &str) -> (bool, bool, Option<String>) {
    match inventory {
        Ok((_, held)) => match held.get(task_id) {
            Some(enabled) => (true, *enabled, None),
            None => (false, false, None),
        },
        Err(e) => (
            false,
            false,
            Some(format!(
                "The system scheduler could not be inspected: {}",
                e
            )),
        ),
    }
}

pub fn scheduler_status(ctx: &Ctx, host_id: String) -> Result<Vec<TaskStatus>, String> {
    // Blocking by design: shells out to crontab/schtasks, once per backend.
    let dirs = ctx.dirs.clone();
    let host_id = sanitize_id(&host_id)?;

    // The backend's inventory, taken the first time a task needs it.
    let mut taken: Option<Inventory> = None;
    let mut statuses = Vec::new();
    for spec in jobfile::list(&dirs, &host_id) {
        let inventory = taken.get_or_insert_with(|| take_inventory(&dirs));
        let (installed, enabled, inspection) = install_state_of(inventory, &spec.task_id);
        let warning = inspection.or_else(|| {
            inventory
                .as_ref()
                .ok()
                .and_then(|(backend, _)| backend.health_warning(&spec.task_id))
        });

        let running = history::is_running(&dirs, &spec.task_id);
        let lines = history::read(&dirs, &spec.task_id, 20);
        let event_of = |line: &serde_json::Value| {
            line.get("event")
                .and_then(|e| e.as_str())
                .map(str::to_owned)
        };
        // Newest-first: the latest started/finished event is the latest ATTEMPT. A started
        // with no finished and no live lock is a run that died without writing its terminal
        // record (crash, SIGKILL, power loss, Task Scheduler hard timeout) — surfacing the
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

/// Remove every registration this app ever made (Settings escape hatch / pre-uninstall cleanup).
/// Sweeps both job files and orphaned OS artifacts by prefix.
pub fn scheduler_unregister_all(ctx: &Ctx) -> Result<u32, String> {
    let dirs = ctx.dirs.clone();
    let _guard = mutation_guard();
    let backends = all_backends(&dirs);
    let mut removed: u32 = 0;

    let jobs_root = dirs.root.join("scheduler").join("jobs");
    if let Ok(host_dirs) = std::fs::read_dir(&jobs_root) {
        for host_dir in host_dirs.flatten() {
            let host_id = host_dir.file_name().to_string_lossy().to_string();
            for spec in jobfile::list(&dirs, &host_id) {
                // Uninstall from every backend (macOS: launchd + crontab).
                if backends.iter().any(|b| b.uninstall(&spec.task_id).is_ok()) {
                    removed += 1;
                }
                jobfile::remove(&dirs, &host_id, &spec.task_id);
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

/// Sweep OS artifacts that have NO job file, across every backend on this platform (macOS:
/// crontab + launchd). These leftovers appear when an OS-level uninstall fails after the job
/// file was removed; a DISABLED leftover never fires, so the runner's fire-time self-heal can
/// never reach it — this sweep is the only thing that does.
fn sweep_orphans(dirs: &DataDir) -> u32 {
    sweep_backends(&all_backends(dirs), &registered_task_ids(dirs))
}

/// Uninstalls, on each backend, what it holds beyond `keep`. A backend that cannot be inspected
/// is left alone (an inspection failure never authorises a deletion), and only what this
/// profile made is touched.
pub(crate) fn sweep_backends(
    backends: &[Box<dyn SchedulerBackend>],
    keep: &HashSet<String>,
) -> u32 {
    let mut removed = 0;
    for backend in backends {
        let Ok(registrations) = backend.inventory() else {
            continue;
        };
        for registration in registrations {
            let id = registration.task_id;
            if keep.contains(&id) || !registration.owned || sanitize_id(&id).is_err() {
                continue;
            }
            if backend.uninstall(&id).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

#[cfg(test)]
mod inventory_tests {
    use super::*;

    /// An uninspectable backend reports itself, rather than every task as "not installed".
    #[test]
    fn an_inspection_failure_is_a_warning_not_an_absence() {
        let failed: Inventory = Err("crontab -l failed: not allowed".into());
        let (installed, enabled, warning) = install_state_of(&failed, "t1");
        assert!(!installed && !enabled);
        assert!(warning.unwrap().contains("not allowed"));
    }

    /// A backend that cannot be inspected keeps its artifacts; nothing is swept on a guess.
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
        let backends: Vec<Box<dyn SchedulerBackend>> =
            vec![Box::new(Broken(std::sync::Mutex::new(0)))];
        assert_eq!(sweep_backends(&backends, &HashSet::new()), 0);
    }
}

/// Startup-reconcile hook for the sweep above. Runs AFTER the reconcile has re-registered every
/// stored task (their job files then exist and protect their artifacts).
pub fn scheduler_sweep_orphans(ctx: &Ctx) -> Result<u32, String> {
    let dirs = ctx.dirs.clone();
    let _guard = mutation_guard();
    Ok(sweep_orphans(&dirs))
}
