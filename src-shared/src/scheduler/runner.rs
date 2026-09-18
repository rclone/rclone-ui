//! Headless `run-task` engine: executes one scheduled task end-to-end without any GUI.
//!
//! Spawns a transient, private rclone daemon (task's binary + config, ephemeral localhost port,
//! random credentials), POSTs the pre-serialized RC requests from the job file, polls to
//! terminal state, records history, and dispatches the schedule.* webhooks.
//!
//! Exit codes: 0 success · 1 run failed · 2 setup error · 3 skipped (already running).

use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use super::history::{self, HistoryLine, RunLog};
use super::jobfile::{self, JobSpec, RcRequest};
use super::storeread::{self, DataDir};
use crate::notifications::{os, webhooks};
use crate::transfers::ledger::{self, Finished, Line, Started, State, Stats};
use crate::transfers::status::{keep_outcome, merge_failed, run_error, stats_of, Failed};

const READINESS_TIMEOUT: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_secs(2);

static TERMINATED: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
extern "C" fn on_sigterm(_: libc::c_int) {
    TERMINATED.store(true, Ordering::SeqCst);
}

fn install_sigterm_handler() {
    #[cfg(unix)]
    unsafe {
        let handler = on_sigterm as extern "C" fn(libc::c_int);
        libc::signal(libc::SIGTERM, handler as usize as libc::sighandler_t);
    }
}

pub fn run(task_id: &str, host_id: &str, forced: bool, data_dir: Option<&str>) -> i32 {
    // forced: a manual Run Now — bypass the macOS launchd catch-up suppression (a manual run is
    // intentionally off-schedule). Unused on non-macOS builds.
    #[cfg(not(target_os = "macos"))]
    let _ = forced;
    let Ok(task_id) = super::sanitize_id(task_id) else {
        eprintln!("run-task: invalid task id");
        return 2;
    };
    let Ok(host_id) = super::sanitize_id(host_id) else {
        eprintln!("run-task: invalid host id");
        return 2;
    };
    // Prefer the data directory baked into the trigger at registration (the GUI's resolved
    // path): schedulers hand us a bare environment, so re-deriving it can diverge — a
    // session-set XDG_DATA_HOME is invisible to cron. Old triggers without the flag fall back
    // to deriving.
    let dirs = match data_dir {
        Some(data) => DataDir {
            root: std::path::PathBuf::from(data),
        },
        None => match storeread::app_dirs() {
            Ok(d) => d,
            Err(e) => {
                eprintln!("run-task: {}", e);
                return 2;
            }
        },
    };
    // The layout must be the one this build reads. The owning app migrates it, never the
    // runner: a fire between an update and the app's first launch is skipped, and nothing is
    // written into a directory laid out for another version.
    if let Err(e) = crate::storage::require_current(&dirs.root) {
        eprintln!("run-task: {}", e);
        return 2;
    }

    let mut log = RunLog::open(&dirs, &task_id);
    log.line(&format!("run-task {} (host {})", task_id, host_id));

    // No Flatpak guard here: when running under Flatpak the runner is a fresh sandboxed instance
    // launched by host cron via `flatpak run … run-task`; it drives rclone in-sandbox and never
    // needs host access itself. Registration (mod.rs::backend) is where the permission is gated.

    // Missing job file: the task was deleted but its OS trigger survived (e.g. unregister
    // failed). Self-heal by removing the orphan trigger — from EVERY backend, since on macOS a
    // user-mode trigger lives in launchd, not the default cron backend.
    //
    // Self-heal ONLY on a clean not-found with the jobs directory present. A missing/unreadable
    // data root (unmounted systemd-homed home, wrong XDG-derived path from an old trigger) or a
    // malformed/newer-schema job file is an ENVIRONMENT problem — uninstalling there would
    // destroy a valid registration.
    let spec = match jobfile::load(&dirs, &host_id, &task_id) {
        Ok(spec) => spec,
        Err(e) => {
            let job_path = jobfile::job_path(&dirs, &host_id, &task_id);
            let jobs_dir_present = job_path.parent().map(|p| p.is_dir()).unwrap_or(false);
            if jobs_dir_present && !job_path.exists() {
                log.line(&format!(
                    "job file missing: {} — removing orphan trigger",
                    e
                ));
                for backend in super::all_backends(&dirs) {
                    let _ = backend.uninstall(&task_id);
                }
            } else {
                log.line(&format!(
                    "job file unusable: {} — leaving the trigger in place (environment problem, not an orphan)",
                    e
                ));
            }
            return 2;
        }
    };
    if spec.host_id != "local" {
        log.line("remote-host tasks are not supported by the scheduler");
        return 2;
    }

    // User-mode context handling differs by platform. macOS: launchd fires the task inside the
    // login session already (Keychain, /Volumes, TCC-as-the-app) and only while logged in, so
    // there is nothing to gate — we only suppress launchd's wake-catch-up to honor no-replay.
    // Linux: cron fires regardless of login state, so we gate on an active session and borrow its
    // context. Windows: the interactive logon type is the gate (nothing here).
    if spec.is_user_mode() && super::mode::get() == super::mode::Mode::Native {
        #[cfg(target_os = "macos")]
        {
            if !forced && is_launchd_catchup(&spec) {
                log.line("skipped: missed while asleep (launchd catch-up suppressed)");
                history::append(
                    &dirs,
                    &task_id,
                    &HistoryLine::Skipped {
                        ts: history::now_iso(),
                        reason: "missed while asleep".to_string(),
                    },
                );
                return 3;
            }
        }
        #[cfg(target_os = "linux")]
        {
            if !user_has_login_session() {
                log.line("skipped: no active login session");
                history::append(
                    &dirs,
                    &task_id,
                    &HistoryLine::Skipped {
                        ts: history::now_iso(),
                        reason: "no active login session".to_string(),
                    },
                );
                return 3;
            }
            if let Some(runtime_dir) = session_runtime_dir() {
                borrow_session_env(&runtime_dir, &mut log);
            }
        }
    }

    // Held (not dropped) for the entire run: on Unix the flock inside is the mutual exclusion.
    let run_lock = match history::acquire_lock(&dirs, &task_id, spec.max_run_seconds) {
        Ok(history::LockResult::Acquired(lock)) => lock,
        Ok(history::LockResult::Held) => {
            log.line("skipped: another run is in progress");
            history::append(
                &dirs,
                &task_id,
                &HistoryLine::Skipped {
                    ts: history::now_iso(),
                    reason: "already-running".to_string(),
                },
            );
            return 3;
        }
        Err(e) => {
            log.line(&format!("lock error: {}", e));
            return 2;
        }
    };

    install_sigterm_handler();

    let run_id = format!(
        "{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        std::process::id()
    );
    let started_at = Instant::now();
    // The user-facing "max run time" covers the WHOLE run — started-webhook delivery (up to
    // ~17s per target, sequential) and daemon readiness included — not just the rclone jobs.
    let deadline = started_at + Duration::from_secs(spec.max_run_seconds);
    history::append(
        &dirs,
        &task_id,
        &HistoryLine::Started {
            run_id: run_id.clone(),
            ts: history::now_iso(),
            pid: std::process::id(),
            host_id: host_id.clone(),
        },
    );

    let client = webhooks::http_client();
    let root = storeread::read_root(&dirs).unwrap_or_default();
    let task_label = if spec.name.is_empty() {
        spec.operation.clone()
    } else {
        spec.name.clone()
    };

    for line in webhooks::dispatch(
        &dirs,
        &client,
        "schedule.started",
        "Scheduled task started",
        &format!("{} started", task_label),
        json!({ "scheduleId": task_id, "operation": spec.operation, "cron": spec.cron }),
    ) {
        log.line(&line);
    }

    close_stale_transfers(&dirs, &task_id);
    let mut outcome = execute(
        &dirs, &spec, &task_id, &run_id, &root, &client, deadline, &mut log,
    );
    if let Some(error) = outcome.error.take() {
        outcome.error = Some(annotate_session_failure(error, &spec));
    }

    let duration_ms = started_at.elapsed().as_millis() as u64;
    history::append(
        &dirs,
        &task_id,
        &HistoryLine::Finished {
            run_id,
            ts: history::now_iso(),
            success: outcome.error.is_none(),
            error: outcome.error.clone(),
            duration_ms,
            jobids: if outcome.jobids.is_empty() {
                None
            } else {
                Some(outcome.jobids.clone())
            },
            stats: outcome.stats.clone(),
        },
    );

    // Release BEFORE the completion webhooks: the run's work is done, and holding the lock
    // through up-to-minutes of sequential webhook delivery would make the next scheduled fire
    // skip as "already-running".
    run_lock.release();

    let (event, title, body) = match &outcome.error {
        None => (
            "schedule.completed",
            "Scheduled task completed",
            format!("{} completed successfully", task_label),
        ),
        Some(error) => (
            "schedule.failed",
            "Scheduled task failed",
            format!("{} failed: {}", task_label, error),
        ),
    };
    let mut data =
        json!({ "scheduleId": task_id, "operation": spec.operation, "durationMs": duration_ms });
    if let Some(error) = &outcome.error {
        data["error"] = Value::String(error.clone());
    }
    for line in webhooks::dispatch(&dirs, &client, event, title, &body, data) {
        log.line(&line);
    }

    // OS toast for the terminal state — hardcoded to completed/failed (started would be noise).
    // Scheduled runs happen with the GUI possibly closed, so the runner must post it itself.
    if let Err(e) = os::notify_headless(title, &body) {
        log.line(&format!("os notification failed: {}", e));
    }

    log.line(&format!(
        "finished: {} ({} ms)",
        outcome.error.as_deref().unwrap_or("success"),
        duration_ms
    ));

    if outcome.setup_failure {
        2
    } else if outcome.error.is_some() {
        1
    } else {
        0
    }
}

/// Whether this launchd fire is a wake-catch-up (a run for a time missed while asleep/off) rather
/// than an on-time fire. launchd fires an on-time job at the scheduled minute — which the cron
/// matches — whereas a catch-up fires at wake time, on some arbitrary non-matching minute. We
/// check the current AND previous minute so launchd's sub-second jitter across a minute boundary
/// still counts as on-time. Unparseable cron fails open (does not suppress).
#[cfg(target_os = "macos")]
fn is_launchd_catchup(spec: &JobSpec) -> bool {
    use chrono::{Datelike, Timelike};
    let Ok(cron) = super::cronconv::parse(&spec.cron) else {
        return false;
    };
    let now = chrono::Local::now();
    for minutes_ago in [0i64, 1] {
        let t = now - chrono::Duration::minutes(minutes_ago);
        if super::cronconv::matches(
            &cron,
            t.minute() as u16,
            t.hour() as u16,
            t.day() as u16,
            t.month() as u16,
            t.weekday().num_days_from_sunday() as u16,
        ) {
            return false;
        }
    }
    true
}

/// Whether the user currently has a real login session — the ONLY thing that authorizes a
/// user-mode run. `/run/user/<uid>` alone is NOT that check: `loginctl enable-linger` keeps the
/// user manager (and the runtime dir) alive after logout. And raw `SESSIONS=` entries are not
/// enough either: on distros whose cron PAM stack includes pam_systemd, the cron job that fired
/// us registers its OWN logind session (SERVICE=cron, CLASS=background on current systemd) — a
/// gate counting raw sessions would authorize itself. So each session id is checked against its
/// `/run/systemd/sessions/<id>` state file and background/cron/at sessions are excluded.
///
/// Flatpak: the sandbox never sees `/run/systemd` (a reserved path — even `--filesystem=host`
/// mounts the host at /run/host, never over /run), so the strict check is unreachable there.
/// Gate on the proxied session D-Bus socket instead: flatpak wires it into the sandbox only
/// when the host session bus exists, and it is exactly the context a user-mode run needs
/// (keyring via secret-service, portals). Accepted caveat: lingering keeps the host bus alive,
/// so under Flatpak lingering counts as logged in.
///
/// No other leniency: without logind state we cannot PROVE a session, and a user-mode task must
/// never run outside one just because borrowable context happens to exist — that is what System
/// mode is for. (systemd-logind and elogind both write these files.)
#[cfg(target_os = "linux")]
pub(super) fn user_has_login_session() -> bool {
    if crate::is_flatpak() {
        return session_runtime_dir()
            .map(|dir| dir.join("bus").exists())
            .unwrap_or(false);
    }

    let uid = unsafe { libc::getuid() };
    let Ok(state) = std::fs::read_to_string(format!("/run/systemd/users/{}", uid)) else {
        return false;
    };
    let Some(sessions) = state
        .lines()
        .find_map(|line| line.strip_prefix("SESSIONS="))
    else {
        return false;
    };
    sessions.split_whitespace().any(is_real_login_session)
}

/// Whether a logind session id is a live user login rather than a background job session
/// (cron/at via pam_systemd) or one already tearing down.
#[cfg(target_os = "linux")]
fn is_real_login_session(session_id: &str) -> bool {
    let Ok(info) = std::fs::read_to_string(format!("/run/systemd/sessions/{}", session_id)) else {
        return false;
    };
    let field = |key: &str| {
        info.lines()
            .find_map(|line| line.strip_prefix(key))
            .unwrap_or("")
            .trim()
    };
    // background / background-light are the non-login classes (systemd ≥ 252 puts cron and at
    // jobs there); on older systemd those jobs still carry the scheduler's SERVICE name with
    // CLASS=user, hence the explicit service exclusions. A "closing" session has already lost
    // its user context.
    if field("CLASS=").starts_with("background") || field("STATE=") == "closing" {
        return false;
    }
    !matches!(
        field("SERVICE="),
        "cron" | "crond" | "cronie" | "atd" | "anacron"
    )
}

/// The user manager's runtime dir, when present — the session context worth borrowing.
#[cfg(target_os = "linux")]
fn session_runtime_dir() -> Option<std::path::PathBuf> {
    let dir = std::path::PathBuf::from(format!("/run/user/{}", unsafe { libc::getuid() }));
    dir.is_dir().then_some(dir)
}

/// Borrow the login session's context: XDG_RUNTIME_DIR and the session D-Bus address are what
/// keyring password commands (secret-tool) and gvfs mounts need. Inherited by the transient
/// rclone daemon and everything it spawns.
#[cfg(target_os = "linux")]
fn borrow_session_env(runtime_dir: &std::path::Path, log: &mut RunLog) {
    if std::env::var_os("XDG_RUNTIME_DIR").is_none() {
        std::env::set_var("XDG_RUNTIME_DIR", runtime_dir);
    }
    let bus = runtime_dir.join("bus");
    if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() && bus.exists() {
        std::env::set_var(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path={}", bus.display()),
        );
    }
    log.line("user mode: borrowed login session environment (XDG_RUNTIME_DIR, session D-Bus)");
}

/// Failure hints for session-context errors, so the history/webhook error names the actual fix
/// instead of leaving the user to guess. macOS user-mode runs execute as the app via a
/// LaunchAgent — a protected-folder denial means the app itself lacks the grant (and a background
/// run can't prompt), so the fix is to grant the APP. System-mode runs that trip session-shaped
/// errors are pointed at the 'User' run mode (or, on macOS, cron's FDA grant).
fn annotate_session_failure(error: String, spec: &JobSpec) -> String {
    let lower = error.to_lowercase();

    if spec.is_user_mode() && super::mode::get() == super::mode::Mode::Native {
        #[cfg(target_os = "macos")]
        {
            if lower.contains("operation not permitted") || lower.contains("permission denied") {
                return format!(
                    "{} — this task runs as Rclone UI, but a scheduled run cannot show a permission prompt, so the app must be granted access first: grant Rclone UI access to the folder (open it once in the app), or add Rclone UI to Full Disk Access in System Settings → Privacy & Security.",
                    error
                );
            }
        }
        return error;
    }

    let session_shaped = lower.contains("operation not permitted")
        || lower.contains("permission denied")
        || lower.contains("password command")
        || lower.contains("directory not found")
        || lower.contains("no such file or directory");
    if !session_shaped {
        return error;
    }
    #[cfg(target_os = "macos")]
    let fda_hint =
        ", or grant Full Disk Access to /usr/sbin/cron in System Settings → Privacy & Security";
    #[cfg(not(target_os = "macos"))]
    let fda_hint = "";
    format!(
        "{} — this schedule runs in System mode, outside your login session: no OS keychain, session-mounted drives, or (on macOS) protected folders. If it works when run manually, switch its run mode to 'User' in the schedule's settings{}.",
        error, fda_hint
    )
}

struct RunOutcome {
    error: Option<String>,
    setup_failure: bool,
    jobids: Vec<i64>,
    stats: Option<Value>,
}

impl RunOutcome {
    fn setup(error: String) -> Self {
        Self {
            error: Some(error),
            setup_failure: true,
            jobids: Vec::new(),
            stats: None,
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn execute(
    dirs: &DataDir,
    spec: &JobSpec,
    task_id: &str,
    run_id: &str,
    root: &storeread::RootState,
    client: &reqwest::Client,
    deadline: Instant,
    log: &mut RunLog,
) -> RunOutcome {
    // Binary resolution.
    let binary = if spec.binary == "app-default" {
        match root.rclone_path.as_deref().filter(|p| !p.is_empty()) {
            Some(p) => p.to_string(),
            None => {
                return RunOutcome::setup(
                    "no rclone binary configured — open Rclone UI to set one up".to_string(),
                )
            }
        }
    } else {
        spec.binary.clone()
    };
    if !std::path::Path::new(&binary).is_file() {
        return RunOutcome::setup(format!(
            "rclone binary not found at {} — open Rclone UI to repair the schedule",
            binary
        ));
    }

    // Config + env.
    let host = match storeread::read_host(dirs, &spec.host_id) {
        Ok(h) => h,
        Err(e) => return RunOutcome::setup(e),
    };
    let config_path = storeread::resolve_config_path(dirs, &host, &spec.config_id);
    if !config_path.is_file() {
        return RunOutcome::setup(format!(
            "config file not found at {} — open Rclone UI to repair the schedule",
            config_path.display()
        ));
    }
    let config_entry = storeread::find_config(&host, &spec.config_id);
    let env = match storeread::build_run_env(&host, config_entry, &config_path) {
        Ok(env) => env,
        Err(e) => return RunOutcome::setup(e),
    };

    // Transient daemon.
    let port = match pick_port() {
        Ok(p) => p,
        Err(e) => return RunOutcome::setup(e),
    };
    let user = random_token("user");
    let pass = random_token("pass");
    let base = format!("http://127.0.0.1:{}", port);

    log.line(&format!(
        "starting transient daemon: {} (port {})",
        binary, port
    ));

    let daemon_log_path = history::log_path(dirs, task_id).with_extension("daemon.log");
    // Verbose (INFO) logging grows fast — rotate the daemon log independently of the runner log.
    history::rotate_file(&daemon_log_path, 4 * 1024 * 1024);
    let daemon_log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&daemon_log_path)
        .ok();

    let rc_addr = format!("127.0.0.1:{}", port);
    let mut daemon_args = vec![
        "rcd",
        "--rc-addr",
        &rc_addr,
        "--rc-user",
        &user,
        "--rc-pass",
        &pass,
    ];
    if spec.verbose_logging {
        daemon_args.extend(["--log-level", "INFO"]);
    }

    let mut cmd = Command::new(&binary);
    cmd.args(&daemon_args);
    for (k, v) in &env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(match daemon_log {
        Some(file) => Stdio::from(file),
        None => Stdio::null(),
    });
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return RunOutcome::setup(format!("failed to start rclone: {}", e)),
    };
    history::record_daemon_pid(dirs, task_id, child.id());

    // Tie the daemon's lifetime to this process: Task Scheduler's hard kill (TerminateProcess)
    // runs no destructors, so without the job object a hung, hard-killed runner orphans it.
    #[cfg(windows)]
    let job = match super::winjob::KillOnCloseJob::assign(&child) {
        Ok(job) => Some(job),
        Err(e) => {
            log.line(&format!(
                "job object unavailable ({}) — a hard-killed runner would orphan the daemon until the next run's cleanup",
                e
            ));
            None
        }
    };

    let mut daemon = DaemonGuard {
        child,
        client: client.clone(),
        quit_url: format!("{}/core/quit", base),
        user: user.clone(),
        pass: pass.clone(),
        cleaned: false,
        #[cfg(windows)]
        _job: job,
    };

    // Readiness.
    let ready_deadline = Instant::now() + READINESS_TIMEOUT;
    loop {
        if let Ok(Some(status)) = daemon.child.try_wait() {
            return RunOutcome::setup(format!(
                "rclone daemon exited during startup (code {:?}) — see the task's daemon log",
                status.code()
            ));
        }
        let ready = rc_call(client, &base, &user, &pass, "/rc/noop", &json!({})).is_ok();
        if ready {
            break;
        }
        if Instant::now() >= ready_deadline {
            return RunOutcome::setup("rclone daemon did not become ready within 15s".to_string());
        }
        std::thread::sleep(Duration::from_millis(250));
    }

    // Execute the stored requests sequentially (deadline covers the whole run — set in run()).
    let mut jobids: Vec<i64> = Vec::new();
    let mut stats: Option<Value> = None;

    for request in &spec.requests {
        let submitted = match rc_call(
            client,
            &base,
            &user,
            &pass,
            &request.endpoint,
            &request.body,
        ) {
            Ok(v) => v,
            Err(e) => {
                return RunOutcome {
                    error: Some(format!("failed to submit {}: {}", request.endpoint, e)),
                    setup_failure: false,
                    jobids,
                    stats,
                }
            }
        };
        let Some(jobid) = submitted.get("jobid").and_then(|j| j.as_i64()) else {
            return RunOutcome {
                error: Some(format!(
                    "{} returned no jobid: {}",
                    request.endpoint, submitted
                )),
                setup_failure: false,
                jobids,
                stats,
            };
        };
        jobids.push(jobid);
        log.line(&format!("submitted {} as job {}", request.endpoint, jobid));
        // Which daemon took it comes in the same reply as the job's id.
        let execute_id = submitted["executeId"].as_str().unwrap_or_default();
        let transfer = record_transfer_started(dirs, spec, run_id, request, jobid, execute_id);

        // Poll to terminal state, gathering the files that fail as they go by: rclone forgets all
        // but a job's last 100, so by the end of a long run the early ones are gone.
        let group = json!({ "group": format!("job/{}", jobid) });
        let mut failed = Failed::default();
        let job_status: Value = loop {
            if TERMINATED.load(Ordering::SeqCst) {
                let _ = rc_call(
                    client,
                    &base,
                    &user,
                    &pass,
                    "/job/stop",
                    &json!({ "jobid": jobid }),
                );
                record_transfer_end(
                    dirs,
                    task_id,
                    &transfer,
                    State::Interrupted,
                    Some("terminated by the system".to_string()),
                    None,
                );
                return RunOutcome {
                    error: Some("terminated by the system".to_string()),
                    setup_failure: false,
                    jobids,
                    stats,
                };
            }
            if Instant::now() >= deadline {
                let _ = rc_call(
                    client,
                    &base,
                    &user,
                    &pass,
                    "/job/stop",
                    &json!({ "jobid": jobid }),
                );
                record_transfer_end(
                    dirs,
                    task_id,
                    &transfer,
                    State::Failed,
                    Some(format!("timed out after {} seconds", spec.max_run_seconds)),
                    None,
                );
                return RunOutcome {
                    error: Some(format!("timed out after {} seconds", spec.max_run_seconds)),
                    setup_failure: false,
                    jobids,
                    stats,
                };
            }
            match rc_call(
                client,
                &base,
                &user,
                &pass,
                "/job/status",
                &json!({ "jobid": jobid }),
            ) {
                Ok(status) => {
                    if status.get("finished").and_then(|f| f.as_bool()) == Some(true) {
                        break status;
                    }
                    if let Ok(reply) =
                        rc_call(client, &base, &user, &pass, "/core/transferred", &group)
                    {
                        merge_failed(&mut failed, &reply["transferred"]);
                    }
                }
                Err(e) => {
                    // Daemon died mid-run (crash, or the GUI's "stop all rclone processes").
                    if let Ok(Some(code)) = daemon.child.try_wait() {
                        record_transfer_end(
                            dirs,
                            task_id,
                            &transfer,
                            State::Interrupted,
                            Some("rclone daemon exited unexpectedly".to_string()),
                            None,
                        );
                        return RunOutcome {
                            error: Some(format!(
                                "rclone daemon exited unexpectedly (code {:?}): {}",
                                code.code(),
                                e
                            )),
                            setup_failure: false,
                            jobids,
                            stats,
                        };
                    }
                }
            }
            std::thread::sleep(POLL_INTERVAL);
        };

        // Best-effort stats before evaluating the outcome.
        let mut totals: Option<Stats> = None;
        if let Ok(job_stats) = rc_call(client, &base, &user, &pass, "/core/stats", &group) {
            stats = Some(json!({
                "bytes": job_stats.get("bytes"),
                "transfers": job_stats.get("transfers"),
                "errors": job_stats.get("errors"),
            }));
            totals = Some(stats_of(&job_stats, &job_status));
        }
        // What the transfer's own drawer shows once this daemon is gone: rclone's last word on
        // the job and the files it moved.
        let transferred = rc_call(client, &base, &user, &pass, "/core/transferred", &group)
            .map(|reply| reply["transferred"].clone())
            .unwrap_or_default();
        merge_failed(&mut failed, &transferred);
        let mut details = json!({});
        keep_outcome(&mut details, &job_status, &transferred, &failed);
        let _ = ledger::write_details(dirs, &transfer, &details);

        // Stricter than the app's launch check (which fails only when every input of a batch
        // did): a scheduled run with some of its inputs failed must not report success.
        let failure = run_error(&job_status);
        record_transfer_end(
            dirs,
            task_id,
            &transfer,
            if failure.is_some() {
                State::Failed
            } else {
                State::Completed
            },
            failure.clone(),
            totals,
        );
        if let Some(error) = failure {
            return RunOutcome {
                error: Some(error),
                setup_failure: false,
                jobids,
                stats,
            };
        }
        log.line(&format!("job {} completed successfully", jobid));
    }

    daemon.shutdown();
    RunOutcome {
        error: None,
        setup_failure: false,
        jobids,
        stats,
    }
}

/// What a run's transfer lists as its paths: the task's own, or for a job file written before
/// they were kept, whatever its request names.
fn transfer_paths(spec: &JobSpec, request: &RcRequest) -> (Vec<String>, Option<String>) {
    if !spec.sources.is_empty() || spec.destination.is_some() {
        return (spec.sources.clone(), spec.destination.clone());
    }
    let text = |value: &Value, key: &str| value[key].as_str().map(str::to_string);
    let join = |fs: String, remote: Option<String>| match remote.filter(|r| !r.is_empty()) {
        Some(remote) if fs.ends_with(':') || fs.ends_with('/') => format!("{}{}", fs, remote),
        Some(remote) => format!("{}/{}", fs, remote),
        None => fs,
    };
    let body = &request.body;
    let inputs: Vec<&Value> = match body["inputs"].as_array() {
        Some(inputs) => inputs.iter().collect(),
        None => vec![body],
    };
    let sources = inputs
        .iter()
        .filter_map(|input| {
            text(input, "srcFs")
                .map(|fs| join(fs, text(input, "srcRemote")))
                .or_else(|| text(input, "fs").map(|fs| join(fs, text(input, "remote"))))
                .or_else(|| text(input, "path1"))
        })
        .collect();
    let destination = inputs
        .iter()
        .find_map(|input| text(input, "dstFs").or_else(|| text(input, "path2")));
    (sources, destination)
}

/// The transfer a run's job is recorded as, in the task's own file (this process is its one
/// writer, under the run lock). Carries the schedule and the run, which is how the Transfers
/// page knows to send its row to the Schedules page.
fn record_transfer_started(
    dirs: &DataDir,
    spec: &JobSpec,
    run_id: &str,
    request: &RcRequest,
    jobid: i64,
    execute_id: &str,
) -> String {
    let (sources, destination) = transfer_paths(spec, request);
    let id = format!("{}-{}", run_id, jobid);
    let started = Started {
        id: id.clone(),
        ts: history::now_iso(),
        host_id: spec.host_id.clone(),
        execute_id: execute_id.to_string(),
        jobid,
        operation: spec.operation.clone(),
        sources,
        destination,
        task_id: Some(spec.task_id.clone()),
        task_name: Some(spec.name.clone()).filter(|name| !name.is_empty()),
        run_id: Some(run_id.to_string()),
        tags: vec![ledger::TAG_SCHEDULE.to_string()],
        ..Started::default()
    };
    let _ = ledger::append(
        &ledger::task_path(dirs, &spec.task_id),
        &Line::Started(started),
    );
    id
}

fn record_transfer_end(
    dirs: &DataDir,
    task_id: &str,
    id: &str,
    state: State,
    error: Option<String>,
    stats: Option<Stats>,
) {
    let finished = Finished {
        id: id.to_string(),
        ts: history::now_iso(),
        state,
        error,
        stats,
    };
    let _ = ledger::finish(dirs, &ledger::task_path(dirs, task_id), finished);
}

/// A run that was killed outright never wrote how its transfer ended. The lock is ours, so
/// whatever this task's file still holds open is from such a run.
fn close_stale_transfers(dirs: &DataDir, task_id: &str) {
    for stale in ledger::open(&ledger::task_path(dirs, task_id)) {
        record_transfer_end(
            dirs,
            task_id,
            &stale.id,
            State::Interrupted,
            Some("The run ended without saying how.".to_string()),
            None,
        );
    }
}

fn rc_call(
    client: &reqwest::Client,
    base: &str,
    user: &str,
    pass: &str,
    endpoint: &str,
    body: &Value,
) -> Result<Value, String> {
    crate::rt::block_on(async {
        let response = client
            .post(format!("{}{}", base, endpoint))
            .basic_auth(user, Some(pass))
            .json(body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        let value: Value = response.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            let message = value
                .get("error")
                .and_then(|e| e.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("status {}", status));
            return Err(message);
        }
        Ok(value)
    })
}

pub fn pick_port() -> Result<u16, String> {
    for _ in 0..10 {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
            .map_err(|e| format!("failed to allocate a port: {}", e))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        drop(listener);
        // Never collide with the GUI daemon's fixed RC port.
        if port != 5572 {
            return Ok(port);
        }
    }
    Err("could not allocate a local port".to_string())
}

pub fn random_token(salt: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(format!(
        "{:?}-{}-{}",
        SystemTime::now(),
        std::process::id(),
        salt
    ));
    hasher
        .finalize()
        .iter()
        .take(12)
        .map(|b| format!("{:02x}", b))
        .collect()
}

/// Guarantees the transient daemon dies with the run — graceful /core/quit, then kill. The Drop
/// impl covers panics and every early-return path; the next run's stale-lock daemonPid cleanup
/// (and Task Scheduler's ExecutionTimeLimit on Windows) are the nets behind this net — cron
/// itself does not supervise or kill job process trees.
struct DaemonGuard {
    child: Child,
    client: reqwest::Client,
    quit_url: String,
    user: String,
    pass: String,
    cleaned: bool,
    /// Kill-on-close job object holding the daemon (see winjob.rs). Dropped after the graceful
    /// shutdown; the kernel drops it on ANY runner death, including TerminateProcess.
    #[cfg(windows)]
    _job: Option<super::winjob::KillOnCloseJob>,
}

impl DaemonGuard {
    fn shutdown(&mut self) {
        if self.cleaned {
            return;
        }
        self.cleaned = true;

        let _ = crate::rt::block_on(async {
            self.client
                .post(&self.quit_url)
                .basic_auth(&self.user, Some(&self.pass))
                .json(&json!({}))
                .send()
                .await
        });

        let grace_deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            if Instant::now() >= grace_deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(extra: Value) -> JobSpec {
        let mut spec = json!({
            "schemaVersion": 1, "taskId": "t", "hostId": "local", "name": "Nightly",
            "operation": "copy", "cron": "0 2 * * *", "configId": "default",
            "binary": "app-default", "requests": [],
        });
        for (key, value) in extra.as_object().unwrap() {
            spec[key] = value.clone();
        }
        serde_json::from_value(spec).unwrap()
    }

    fn request(endpoint: &str, body: Value) -> RcRequest {
        RcRequest {
            endpoint: endpoint.into(),
            body,
        }
    }

    /// A run's transfer says it came from a schedule: that tag, not the task id beside it, is
    /// what the pages go by.
    #[test]
    fn a_runs_transfer_is_tagged_as_a_schedules() {
        let root = std::env::temp_dir().join(format!("rcloneui-run-tag-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dirs = DataDir { root };
        let job = spec(json!({}));
        record_transfer_started(
            &dirs,
            &job,
            "run-1",
            &request("/job/batch", json!({ "inputs": [] })),
            7,
            "daemon-1",
        );
        let entries = ledger::list(&dirs, &job.host_id, 10);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].tags, [ledger::TAG_SCHEDULE]);
        assert_eq!(entries[0].task_id.as_deref(), Some(job.task_id.as_str()));
        let _ = std::fs::remove_dir_all(&dirs.root);
    }

    /// A run's transfer has to say what it ran on. New job files carry the page's own paths;
    /// the ones registered before that are read off their requests, whatever the operation.
    #[test]
    fn a_runs_transfer_names_its_paths() {
        let kept = spec(json!({ "sources": ["gdrive:photos"], "destination": "/backup" }));
        assert_eq!(
            transfer_paths(&kept, &request("/job/batch", json!({ "inputs": [] }))),
            (
                vec!["gdrive:photos".to_string()],
                Some("/backup".to_string())
            )
        );

        let old = spec(json!({}));
        let batch = request(
            "/job/batch",
            json!({ "inputs": [
                { "_path": "sync/copy", "srcFs": "gdrive:photos", "dstFs": "/backup/photos" },
                { "_path": "operations/copyfile", "srcFs": "gdrive:", "srcRemote": "a.txt",
                  "dstFs": "/backup", "dstRemote": "a.txt" },
            ] }),
        );
        assert_eq!(
            transfer_paths(&old, &batch),
            (
                vec!["gdrive:photos".to_string(), "gdrive:a.txt".to_string()],
                Some("/backup/photos".to_string())
            )
        );
        let sync = request("/sync/sync", json!({ "srcFs": "/a", "dstFs": "remote:b" }));
        assert_eq!(
            transfer_paths(&old, &sync),
            (vec!["/a".to_string()], Some("remote:b".to_string()))
        );
        let bisync = request(
            "/sync/bisync",
            json!({ "path1": "/a", "path2": "remote:b" }),
        );
        assert_eq!(
            transfer_paths(&old, &bisync),
            (vec!["/a".to_string()], Some("remote:b".to_string()))
        );
        // Delete and purge have no destination.
        let delete = request(
            "/job/batch",
            json!({ "inputs": [{ "_path": "operations/deletefile", "fs": "remote:", "remote": "x/y.txt" }] }),
        );
        assert_eq!(
            transfer_paths(&old, &delete),
            (vec!["remote:x/y.txt".to_string()], None)
        );
    }
}
