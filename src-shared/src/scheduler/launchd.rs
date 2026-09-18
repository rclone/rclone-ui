//! macOS backend for USER-mode tasks: per-user launchd LaunchAgents.
//!
//! Chosen over crontab for user mode because a LaunchAgent runs inside the user's Aqua login
//! session — it has the login Keychain, session-mounted `/Volumes`, and (crucially) TCC attributes
//! protected-folder access to the app's own code signature, so the task inherits the grants the
//! user gave Rclone UI rather than needing Full Disk Access on `/usr/sbin/cron`. It runs even when
//! the app is closed, but only while the user is logged in (launchd loads agents at login and
//! boots them out at logout) — exactly the "User" run-mode contract.
//!
//! macOS SYSTEM-mode tasks stay on crontab (see `crontab.rs`); this backend is user-mode only.
//!
//! Enabled state is durable via FILE LOCATION, not `launchctl disable` (whose override database
//! outlives reinstalls): an enabled agent's plist lives in `~/Library/LaunchAgents/` (auto-loaded
//! at every login); a disabled agent's plist is "parked" under app-data so launchd never sees it.

use std::path::PathBuf;
use std::process::{Command, Stdio};

use super::cronconv::{self, LaunchdCalendar};
use super::storeread::DataDir;
use super::{InstallState, Registration, RenderedSchedule, SchedulerBackend};

const LABEL_PREFIX: &str = "com.rclone.ui.task.";

/// Must match tauri.conf.json `identifier`. Since macOS 13, LaunchAgents surface in System
/// Settings → General → Login Items & Extensions as user-toggleable background items;
/// AssociatedBundleIdentifiers is what makes ours appear under the app's name and icon there
/// instead of an anonymous developer entry.
const APP_BUNDLE_ID: &str = "com.rclone.ui";

pub struct LaunchdBackend {
    /// `~/Library/LaunchAgents` — launchd auto-loads every *.plist here at login.
    launch_agents_dir: PathBuf,
    /// Disabled agents are parked here (outside the auto-load dir) so they stay off across logins.
    parked_dir: PathBuf,
    /// launchd stdout/stderr sink for each agent.
    log_dir: PathBuf,
    /// The data roots every runner invocation carries (`scheduler::data_dir_args`).
    dirs: DataDir,
}

impl LaunchdBackend {
    pub fn new(dirs: &DataDir) -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        Self {
            launch_agents_dir: home.join("Library").join("LaunchAgents"),
            parked_dir: dirs.root.join("scheduler").join("launchd-parked"),
            log_dir: dirs.root.join("scheduler").join("logs"),
            dirs: dirs.clone(),
        }
    }

    fn label(task_id: &str) -> String {
        format!("{}{}", LABEL_PREFIX, task_id)
    }

    fn plist_name(task_id: &str) -> String {
        format!("{}{}.plist", LABEL_PREFIX, task_id)
    }

    fn active_path(&self, task_id: &str) -> PathBuf {
        self.launch_agents_dir.join(Self::plist_name(task_id))
    }

    fn parked_path(&self, task_id: &str) -> PathBuf {
        self.parked_dir.join(Self::plist_name(task_id))
    }

    fn uid() -> u32 {
        unsafe { libc::getuid() }
    }

    fn domain() -> String {
        format!("gui/{}", Self::uid())
    }

    fn service_target(task_id: &str) -> String {
        format!("gui/{}/{}", Self::uid(), Self::label(task_id))
    }

    fn launchctl(args: &[&str]) -> std::io::Result<std::process::Output> {
        Command::new("launchctl").args(args).output()
    }

    /// Whether the service is currently loaded in the gui domain (`launchctl print` exits 0 for a
    /// loaded service, 113 otherwise). This is the check that makes install/enable idempotent:
    /// re-bootstrapping a loaded agent FAILS ("Bootstrap failed: 5: Input/output error"), and
    /// booting it out first would kill a running instance.
    fn is_loaded(task_id: &str) -> bool {
        Self::launchctl(&["print", &Self::service_target(task_id)])
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Unload the service. Not-loaded ("Boot-out failed: 3: No such process") is benign; any
    /// other failure is reported — discarding it would let a disable/uninstall report success
    /// while the loaded service keeps firing until logout.
    fn bootout(task_id: &str) -> Result<(), String> {
        let output = Self::launchctl(&["bootout", &Self::service_target(task_id)])
            .map_err(|e| format!("failed to run launchctl bootout: {}", e))?;
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("No such process") || output.status.code() == Some(3) {
            return Ok(());
        }
        Err(format!("launchctl bootout failed: {}", stderr.trim()))
    }

    fn bootstrap(&self, task_id: &str) -> Result<(), String> {
        // The plist's StandardOutPath/StandardErrorPath live here, and launchd never creates
        // intermediate directories (the job still runs, but its output silently goes nowhere).
        // Created here — the one choke point every load goes through — because a task first
        // installed DISABLED skips install()'s enabled path and reaches launchd only via a
        // later set_enabled(true) → bootstrap().
        std::fs::create_dir_all(&self.log_dir)
            .map_err(|e| format!("failed to create scheduler log dir: {}", e))?;

        // Clear any stale disabled-override for this label before loading. We never write one
        // ourselves (our disable = parking the plist file, not `launchctl disable`), but a prior
        // app version or a user running `launchctl disable gui/<uid>/<label>` by hand leaves an
        // entry in the per-user override DB that silently makes bootstrap fail ("Service is
        // disabled") — which the success check below cannot detect. `enable` is idempotent and,
        // unlike `disable`, safe: it only restores the default (enabled) state.
        let _ = Self::launchctl(&["enable", &Self::service_target(task_id)]);

        let path = self.active_path(task_id);
        let output = Self::launchctl(&["bootstrap", &Self::domain(), &path.to_string_lossy()])
            .map_err(|e| format!("failed to run launchctl bootstrap: {}", e))?;
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Some launchd versions phrase a re-bootstrap of a live agent as "already loaded"; keep
        // accepting that, though callers now check is_loaded() first (current macOS says
        // "Bootstrap failed: 5: Input/output error", which is indistinguishable from a real one).
        if stderr.contains("already") || String::from_utf8_lossy(&output.stdout).contains("already")
        {
            return Ok(());
        }
        Err(format!("launchctl bootstrap failed: {}", stderr.trim()))
    }

    fn build_plist(&self, task_id: &str, rendered: &RenderedSchedule) -> Result<String, String> {
        let calendars = cronconv::to_launchd(&rendered.cron)?;

        let mut program_args = String::new();
        program_args.push_str(&format!(
            "    <string>{}</string>\n",
            escape_xml(&rendered.program.to_string_lossy())
        ));
        for arg in &rendered.args {
            program_args.push_str(&format!("    <string>{}</string>\n", escape_xml(arg)));
        }

        let mut intervals = String::new();
        for cal in &calendars {
            intervals.push_str(&render_calendar(cal));
        }

        let log_path = self.log_dir.join(format!("{}.launchd.log", task_id));
        let log_str = escape_xml(&log_path.to_string_lossy());

        Ok(format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>AssociatedBundleIdentifiers</key>
  <string>{bundle_id}</string>
  <key>ProgramArguments</key>
  <array>
{program_args}  </array>
  <key>StartCalendarInterval</key>
  <array>
{intervals}  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
</dict>
</plist>
"#,
            label = escape_xml(&Self::label(task_id)),
            bundle_id = APP_BUNDLE_ID,
            program_args = program_args,
            intervals = intervals,
            log = log_str,
        ))
    }
}

fn render_calendar(cal: &LaunchdCalendar) -> String {
    let mut body = String::new();
    let mut push = |key: &str, value: Option<u16>| {
        if let Some(v) = value {
            body.push_str(&format!(
                "      <key>{}</key>\n      <integer>{}</integer>\n",
                key, v
            ));
        }
    };
    push("Minute", cal.minute);
    push("Hour", cal.hour);
    push("Day", cal.day);
    push("Weekday", cal.weekday);
    push("Month", cal.month);
    format!("    <dict>\n{}    </dict>\n", body)
}

impl SchedulerBackend for LaunchdBackend {
    fn install(&self, task_id: &str, rendered: &RenderedSchedule) -> Result<(), String> {
        let plist = self.build_plist(task_id, rendered)?;
        let active = self.active_path(task_id);

        if !rendered.enabled {
            // Install directly into the parked (disabled) location — the agent must never be
            // briefly armed. Any previously-active copy is unloaded and removed.
            std::fs::create_dir_all(&self.parked_dir)
                .map_err(|e| format!("failed to create parked dir: {}", e))?;
            std::fs::write(self.parked_path(task_id), plist)
                .map_err(|e| format!("failed to write LaunchAgent plist: {}", e))?;
            let bootout = Self::bootout(task_id);
            let _ = std::fs::remove_file(&active);
            return bootout;
        }

        // Idempotent fast path: identical plist already loaded (the reconcile-on-every-startup
        // case). Skipping the bootout+bootstrap reload here is what keeps opening the app from
        // KILLING a currently-running task — bootout terminates the service's live process.
        if std::fs::read(&active).ok().as_deref() == Some(plist.as_bytes())
            && Self::is_loaded(task_id)
        {
            let _ = std::fs::remove_file(self.parked_path(task_id));
            return Ok(());
        }

        std::fs::create_dir_all(&self.launch_agents_dir)
            .map_err(|e| format!("failed to create LaunchAgents dir: {}", e))?;
        // Bootout BEFORE writing the new definition. launchd has no in-place reload (this kills
        // a running instance, but only on an actual definition change — the fast path above
        // covers no-change). Order matters for crash safety: a crash between these steps then
        // leaves the task unloaded (missed fires, healed by the next reconcile/login) instead
        // of the old definition still firing in-memory while the new plist on disk makes the
        // fast path report everything as fine.
        Self::bootout(task_id)?;
        std::fs::write(&active, plist)
            .map_err(|e| format!("failed to write LaunchAgent plist: {}", e))?;
        // A disabled copy would otherwise shadow the meaning of "installed" — drop it.
        let _ = std::fs::remove_file(self.parked_path(task_id));
        self.bootstrap(task_id)
    }

    fn uninstall(&self, task_id: &str) -> Result<(), String> {
        // Files BEFORE bootout — the order is load-bearing for the runner's orphan self-heal,
        // which calls this from INSIDE the fired agent: bootout SIGTERMs that very process, so
        // anything after it may never run. Removing the plists first means even a bootout that
        // kills us mid-call leaves nothing to reload at the next login (launchd completes the
        // unload independently of our survival). A real bootout failure still surfaces: the
        // loaded service would keep firing until logout while looking uninstalled.
        let _ = std::fs::remove_file(self.active_path(task_id));
        let _ = std::fs::remove_file(self.parked_path(task_id));
        Self::bootout(task_id)
    }

    fn set_enabled(&self, task_id: &str, enabled: bool) -> Result<(), String> {
        let active = self.active_path(task_id);
        let parked = self.parked_path(task_id);
        if enabled {
            if active.exists() {
                // Already in the auto-load dir; load it only if launchd doesn't have it —
                // re-bootstrapping a loaded agent fails (and a bootout first would kill a
                // running instance).
                if Self::is_loaded(task_id) {
                    return Ok(());
                }
                return self.bootstrap(task_id);
            }
            if parked.exists() {
                std::fs::create_dir_all(&self.launch_agents_dir)
                    .map_err(|e| format!("failed to create LaunchAgents dir: {}", e))?;
                std::fs::rename(&parked, &active)
                    .map_err(|e| format!("failed to enable the task: {}", e))?;
                if let Err(e) = self.bootstrap(task_id) {
                    // Roll the plist back to the parked dir: leaving it in LaunchAgents would
                    // arm it for the next login while the failed toggle keeps the UI (and
                    // is_installed, which keys off file location) saying disabled.
                    let _ = std::fs::rename(&active, &parked);
                    return Err(e);
                }
                return Ok(());
            }
            Err(super::NOT_REGISTERED.to_string())
        } else {
            if active.exists() {
                // Unload BEFORE parking: if bootout really fails the service is still live, and
                // parking the plist anyway would report "disabled" while it keeps firing.
                Self::bootout(task_id)?;
                std::fs::create_dir_all(&self.parked_dir)
                    .map_err(|e| format!("failed to create parked dir: {}", e))?;
                std::fs::rename(&active, &parked)
                    .map_err(|e| format!("failed to disable the task: {}", e))?;
                return Ok(());
            }
            if parked.exists() {
                return Ok(()); // already disabled
            }
            Err(super::NOT_REGISTERED.to_string())
        }
    }

    fn run_now(&self, task_id: &str) -> Result<(), String> {
        // Direct detached spawn instead of `launchctl kickstart`: it runs in the app's own
        // in-session context (this command is invoked from the running GUI), works whether the
        // agent is enabled or disabled, and `--forced` bypasses the runner's catch-up suppression
        // (a manual run is intentionally off-schedule). kickstart can't pass the flag.
        let exe = std::env::current_exe().map_err(|e| format!("cannot resolve app path: {}", e))?;
        let mut args: Vec<String> = ["run-task", task_id, "--host", "local", "--forced"]
            .into_iter()
            .map(str::to_string)
            .collect();
        args.extend(super::data_dir_args(&self.dirs));
        Command::new(exe)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("failed to start the task: {}", e))?;
        Ok(())
    }

    fn is_installed(&self, task_id: &str) -> Result<InstallState, String> {
        // File location is the source of truth (durable across logins), mirroring crontab's
        // `#off#` model: LaunchAgents = enabled, parked = disabled.
        if self.active_path(task_id).exists() {
            Ok(InstallState::Installed { enabled: true })
        } else if self.parked_path(task_id).exists() {
            Ok(InstallState::Installed { enabled: false })
        } else {
            Ok(InstallState::NotInstalled)
        }
    }

    fn inventory(&self) -> Result<Vec<Registration>, String> {
        let mut out = Vec::new();
        for (dir, enabled) in [(&self.launch_agents_dir, true), (&self.parked_dir, false)] {
            let entries = match std::fs::read_dir(dir) {
                Ok(entries) => entries,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(format!("failed to read {}: {}", dir.display(), e)),
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if let Some(id) = name
                    .strip_prefix(LABEL_PREFIX)
                    .and_then(|rest| rest.strip_suffix(".plist"))
                {
                    out.push(Registration {
                        task_id: id.to_string(),
                        enabled,
                        owned: true,
                    });
                }
            }
        }
        Ok(out)
    }

    fn health_warning(&self, task_id: &str) -> Option<String> {
        // An active plist that launchd does NOT have loaded while we (a GUI process in the same
        // login session) are running means something outside the app unloaded it — since macOS
        // 13 that is usually the user toggling the background item off in System Settings, which
        // file-location-based is_installed cannot see. (A `launchctl disable` override or manual
        // bootout look the same; the remedy below covers those too, since our enable path clears
        // the override and re-bootstraps.)
        if self.active_path(task_id).exists() && !Self::is_loaded(task_id) {
            return Some(
                "macOS is not running this task — its background item is turned off. Enable Rclone UI under System Settings → General → Login Items & Extensions, or pause and resume the schedule."
                    .to_string(),
            );
        }
        None
    }
}

fn escape_xml(raw: &str) -> String {
    raw.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheduler::cronconv;

    fn dirs() -> DataDir {
        DataDir {
            root: std::env::temp_dir().join("rcloneui-launchd-test"),
        }
    }

    fn rendered(cron: &str) -> RenderedSchedule {
        RenderedSchedule {
            cron: cronconv::parse(cron).unwrap(),
            program: PathBuf::from("/Applications/Rclone UI.app/Contents/MacOS/Rclone UI"),
            args: vec![
                "run-task".into(),
                "abc".into(),
                "--host".into(),
                "local".into(),
            ],
            display_name: "abc".into(),
            user_mode: true,
            enabled: true,
            max_run_seconds: 86_400,
        }
    }

    #[test]
    fn plist_has_label_program_and_calendar() {
        let backend = LaunchdBackend::new(&dirs());
        let plist = backend
            .build_plist("abc", &rendered("*/15 9 * * *"))
            .unwrap();
        assert!(plist.contains("<string>com.rclone.ui.task.abc</string>"));
        // System Settings background-item attribution (macOS 13+).
        assert!(plist
            .contains("<key>AssociatedBundleIdentifiers</key>\n  <string>com.rclone.ui</string>"));
        // The space in the .app path stays a single unquoted argv element.
        assert!(
            plist.contains("<string>/Applications/Rclone UI.app/Contents/MacOS/Rclone UI</string>")
        );
        assert!(plist.contains("<string>run-task</string>"));
        assert!(plist.contains("<key>StartCalendarInterval</key>"));
        // */15 at hour 9 → 4 dicts, each Minute+Hour.
        assert_eq!(plist.matches("<dict>").count(), 1 + 4); // outer dict + 4 calendar dicts
        assert_eq!(plist.matches("<key>Hour</key>").count(), 4);
        assert!(plist.contains("<key>Minute</key>\n      <integer>45</integer>"));
        assert!(plist.contains("<key>RunAtLoad</key>\n  <false/>"));
    }

    #[test]
    fn plist_every_minute_is_empty_calendar_dict() {
        let backend = LaunchdBackend::new(&dirs());
        let plist = backend.build_plist("abc", &rendered("* * * * *")).unwrap();
        // One empty calendar dict (every minute) — no Minute/Hour/Day/Weekday/Month keys.
        assert!(plist.contains("<key>StartCalendarInterval</key>"));
        assert_eq!(plist.matches("<key>Minute</key>").count(), 0);
        assert!(plist.contains("    <dict>\n    </dict>\n"));
    }

    /// End-to-end lifecycle against REAL launchctl (app-scoped label, self-cleaning). Ignored by
    /// default — run explicitly on a macOS dev machine:
    ///   RCLONE_UI_SMOKE_BIN=target/debug/app cargo test --package app launchd::tests::e2e_lifecycle -- --ignored --nocapture
    /// Add RCLONE_UI_SMOKE_WAIT=1 to also wait ~70s for a real launchd fire.
    #[test]
    #[ignore]
    fn e2e_lifecycle() {
        let Ok(bin) = std::env::var("RCLONE_UI_SMOKE_BIN") else {
            eprintln!("skipped: set RCLONE_UI_SMOKE_BIN to the built app binary");
            return;
        };
        let real = super::super::storeread::app_dirs().expect("app dirs");
        let backend = LaunchdBackend::new(&real);
        let task = "ldtest";
        let uid = LaunchdBackend::uid();
        let target = LaunchdBackend::service_target(task);

        let mut r = rendered("* * * * *");
        r.program = PathBuf::from(&bin);
        r.args = vec![
            "run-task".into(),
            task.into(),
            "--host".into(),
            "local".into(),
        ];

        let print_ok = || {
            std::process::Command::new("launchctl")
                .args(["print", &target])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };

        backend.install(task, &r).expect("install");
        assert!(backend.active_path(task).exists(), "plist in LaunchAgents");
        assert!(print_ok(), "bootstrapped (launchctl print succeeds)");
        assert_eq!(
            backend.is_installed(task).unwrap(),
            InstallState::Installed { enabled: true }
        );
        eprintln!("installed + bootstrapped in gui/{}", uid);

        // Re-install with an unchanged definition (the startup-reconcile case) must be a no-op:
        // no bootout (which would kill a running instance) and no failing re-bootstrap.
        backend.install(task, &r).expect("idempotent re-install");
        assert!(print_ok(), "still loaded after re-install");
        // Enabling an already-enabled, already-loaded task must also succeed without touching
        // launchd (a re-bootstrap would fail with 'Bootstrap failed: 5').
        backend
            .set_enabled(task, true)
            .expect("enable when already enabled");
        assert!(print_ok(), "still loaded after redundant enable");
        eprintln!("re-install + redundant enable are no-ops");

        backend.set_enabled(task, false).expect("disable");
        assert!(
            !backend.active_path(task).exists(),
            "plist left LaunchAgents"
        );
        assert!(backend.parked_path(task).exists(), "plist parked");
        assert!(!print_ok(), "bootted out");
        assert_eq!(
            backend.is_installed(task).unwrap(),
            InstallState::Installed { enabled: false }
        );
        eprintln!("disabled (parked, not loaded)");

        backend.set_enabled(task, true).expect("re-enable");
        assert!(backend.active_path(task).exists());
        assert!(print_ok(), "re-bootstrapped");
        eprintln!("re-enabled");

        if std::env::var("RCLONE_UI_SMOKE_WAIT").is_ok() {
            let before = super::super::history::read(&real, task, 50).len();
            eprintln!("waiting up to 80s for a launchd fire...");
            let mut fired = false;
            for _ in 0..16 {
                std::thread::sleep(std::time::Duration::from_secs(5));
                if super::super::history::read(&real, task, 50).len() > before {
                    fired = true;
                    break;
                }
            }
            assert!(fired, "launchd fired the runner within the window");
            eprintln!("launchd fired the runner");
        }

        backend.uninstall(task).expect("uninstall");
        assert!(!backend.active_path(task).exists());
        assert!(!backend.parked_path(task).exists());
        assert!(!print_ok(), "unloaded");
        eprintln!("uninstalled + cleaned up");
    }

    /// A same-definition re-install (what the startup reconcile does for every task) must not
    /// kill a currently-running instance — `launchctl bootout` terminates the service's live
    /// process, so the no-op fast path is load-bearing. Real launchctl; self-cleaning.
    ///   cargo test --package app launchd::tests::e2e_reinstall_preserves_running_instance -- --ignored --nocapture
    #[test]
    #[ignore]
    fn e2e_reinstall_preserves_running_instance() {
        let real = super::super::storeread::app_dirs().expect("app dirs");
        let backend = LaunchdBackend::new(&real);
        let task = "ldkilltest";
        let target = LaunchdBackend::service_target(task);

        // A service that just sleeps, so there is a live process to preserve.
        let mut r = rendered("* * * * *");
        r.program = PathBuf::from("/bin/sleep");
        r.args = vec!["300".into()];

        backend.install(task, &r).expect("install");
        let kick = std::process::Command::new("launchctl")
            .args(["kickstart", &target])
            .status()
            .expect("kickstart");
        assert!(kick.success(), "kickstart started the service");

        let running_pid = || {
            let out = std::process::Command::new("launchctl")
                .args(["print", &target])
                .output()
                .expect("print");
            String::from_utf8_lossy(&out.stdout).lines().find_map(|l| {
                l.trim()
                    .strip_prefix("pid = ")
                    .map(|p| p.trim().to_string())
            })
        };
        let pid_before = running_pid().expect("service has a running pid after kickstart");

        // Same definition → must be a no-op that leaves the running process untouched.
        backend.install(task, &r).expect("re-install");
        let pid_after = running_pid();
        assert_eq!(
            pid_after.as_deref(),
            Some(pid_before.as_str()),
            "re-install must not kill or restart the running instance"
        );
        eprintln!(
            "running pid {} survived a same-definition re-install",
            pid_before
        );

        backend.uninstall(task).expect("uninstall");
        assert!(running_pid().is_none(), "uninstall stops the instance");
    }
}
