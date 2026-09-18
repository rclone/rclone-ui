//! The Unix backend (macOS + Linux): the user's crontab.
//!
//! Chosen deliberately over launchd/systemd: one uniform backend, and cron jobs run
//! whether or not the user is logged in (the cron daemon is system-wide). Known trade-offs:
//! there is NO missed-run catch-up (a fire skipped while the machine sleeps is simply skipped),
//! Linux installs need a cron implementation (bundled as a deb/rpm dependency; the in-app
//! message covers AppImage), and on macOS a job touching TCC-protected folders
//! (Desktop/Documents/Downloads) may require granting Full Disk Access to `cron`.
//!
//! Under Flatpak, `crontab` lives on the host, not in the sandbox, so every invocation is
//! wrapped in `flatpak-spawn --host` (which needs `--talk-name=org.freedesktop.Flatpak`). The
//! install temp file therefore goes under the data directory — `~/.var/app/<id>/…` is the same
//! absolute path inside and outside the sandbox, so the host `crontab` can read it — never
//! sandbox-private `/tmp`.
//!
//! Layout inside the crontab — a managed pair of lines per task, everything else untouched:
//!   # rclone-ui-task: <taskId>
//!   <schedule> '<program>' run-task <taskId> --host local >/dev/null 2>&1
//! A disabled task keeps its pair with the entry line prefixed `#off# `.

use std::path::PathBuf;
use std::process::Command;

use super::storeread::DataDir;
use super::{InstallState, Registration, RenderedSchedule, SchedulerBackend};

const MARKER_PREFIX: &str = "# rclone-ui-task: ";
const DISABLED_PREFIX: &str = "#off# ";

/// A `Command` for a host program — direct off Flatpak, `flatpak-spawn --host <program>` inside
/// the sandbox.
pub(crate) fn host_command(program: &str) -> Command {
    if crate::is_flatpak() {
        let mut cmd = Command::new("flatpak-spawn");
        cmd.arg("--host").arg(program);
        cmd
    } else {
        Command::new(program)
    }
}

pub fn check_available() -> Result<(), String> {
    if crate::is_flatpak() {
        // Probe the host for crontab — this also confirms the spawn permission actually works.
        let ok = host_command("sh")
            .arg("-c")
            .arg("command -v crontab")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        return if ok {
            Ok(())
        } else {
            Err("cron is not installed on the host. Install 'cron' (Debian/Ubuntu) or 'cronie' (Fedora/Arch) to enable scheduling.".to_string())
        };
    }

    let found = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).any(|dir| dir.join("crontab").is_file()))
        .unwrap_or(false);
    if found {
        Ok(())
    } else {
        Err("Scheduling requires a cron service. Install 'cron' (Debian/Ubuntu) or 'cronie' (Fedora/Arch) to enable scheduling.".to_string())
    }
}

/// Classifies a failed `crontab -l`. Must never misclassify a real failure as "empty" — see
/// read() for the wipe hazard. Vixie/cronie/macOS all phrase the fresh-user case as "no crontab".
pub(crate) fn stderr_means_no_crontab(stderr: &str) -> bool {
    stderr.to_lowercase().contains("no crontab")
}

pub struct CrontabBackend {
    /// Where the install temp file goes — under app-data so it is host-visible under Flatpak.
    tmp_dir: PathBuf,
    /// Cross-process lock file for whole-crontab read-modify-write sequences.
    lock_path: PathBuf,
}

/// Guards a crontab read→modify→replace against concurrent writers in OTHER processes — the
/// headless runner's orphan self-heal can race the GUI (whose own webviews are serialized by
/// mod.rs::MUTATION_LOCK, which cannot reach a separate process). Without this, two overlapping
/// writes drop each other's managed pair until the next reconcile. flock on a file under
/// app_data works across Flatpak sandbox instances too (same inode via the shared mount).
struct CrontabLock {
    _file: std::fs::File,
}

impl CrontabLock {
    fn acquire(path: &PathBuf) -> Result<Self, String> {
        use std::os::unix::io::AsRawFd;
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(|e| format!("failed to open the crontab lock: {}", e))?;
        // Bounded wait (~10s): holders finish in milliseconds (one crontab -l + one crontab
        // install, plus flatpak-spawn hops), but a wedged holder must not hang the UI forever.
        // The lock releases with the fd (kernel-managed — a crashed holder frees it).
        for _ in 0..40 {
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                return Ok(Self { _file: file });
            }
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::EWOULDBLOCK) {
                return Err(format!("failed to lock crontab operations: {}", err));
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        Err("another crontab operation is still in progress".to_string())
    }
}

impl CrontabBackend {
    pub fn new(dirs: &DataDir) -> Self {
        Self {
            tmp_dir: dirs.root.join("scheduler").join("tmp"),
            lock_path: dirs
                .root
                .join("scheduler")
                .join("locks")
                .join("crontab.lock"),
        }
    }

    /// Current crontab content. Exactly ONE failure is benign — "no crontab for <user>" (a
    /// fresh user, exit 1). Every other failure (cron.deny "not allowed", PAM/SELinux denial,
    /// spool errors) must abort the operation: treating it as an empty crontab would make the
    /// next write silently WIPE the user's real cron jobs.
    fn read() -> Result<String, String> {
        let output = host_command("crontab")
            .arg("-l")
            .output()
            .map_err(|e| format!("failed to run crontab: {}", e))?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr_means_no_crontab(&stderr) {
            return Ok(String::new());
        }
        Err(format!("crontab -l failed: {}", stderr.trim()))
    }

    /// Replaces the whole crontab via a 0600 temp file (`crontab <file>`), preserving every
    /// line that isn't one of our managed pairs.
    fn write(&self, content: &str) -> Result<(), String> {
        std::fs::create_dir_all(&self.tmp_dir)
            .map_err(|e| format!("failed to create scheduler tmp dir: {}", e))?;
        let tmp = self.tmp_dir.join(format!(
            "crontab-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        {
            use std::io::Write as _;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt as _;
                options.mode(0o600);
            }
            let mut file = options
                .open(&tmp)
                .map_err(|e| format!("failed to create temp crontab: {}", e))?;
            file.write_all(content.as_bytes())
                .map_err(|e| format!("failed to write temp crontab: {}", e))?;
        }

        let result = host_command("crontab")
            .arg(&tmp)
            .output()
            .map_err(|e| format!("failed to run crontab: {}", e));
        let _ = std::fs::remove_file(&tmp);
        let output = result?;
        if !output.status.success() {
            return Err(format!(
                "crontab install failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(())
    }

    fn marker(task_id: &str) -> String {
        format!("{}{}", MARKER_PREFIX, task_id)
    }

    /// Whether a line is verifiably OUR entry for this task. The line after a marker is only
    /// trusted when it references the runner invocation AND the task id — a user who hand-edits
    /// their crontab (deletes the entry but leaves the marker, reorders lines) must never get an
    /// unrelated cron job deleted, `#off#`-disabled, or executed by Run Now in its place.
    fn is_managed_entry(line: &str, task_id: &str) -> bool {
        line.contains("run-task") && line.contains(task_id)
    }

    /// Content with the task's managed pair (marker + following entry) removed. A dangling
    /// marker (its entry line missing or not recognizably ours) is removed alone; the foreign
    /// line stays.
    fn without_pair(content: &str, task_id: &str) -> String {
        let marker = Self::marker(task_id);
        let mut result = String::new();
        let mut lines = content.lines().peekable();
        while let Some(line) = lines.next() {
            if line.trim() == marker {
                if lines
                    .peek()
                    .map(|next| Self::is_managed_entry(next, task_id))
                    .unwrap_or(false)
                {
                    lines.next();
                }
                continue;
            }
            result.push_str(line);
            result.push('\n');
        }
        result
    }

    /// The task's entry line (the validated line after its marker), if present.
    fn find_entry(content: &str, task_id: &str) -> Option<String> {
        let marker = Self::marker(task_id);
        let mut lines = content.lines();
        while let Some(line) = lines.next() {
            if line.trim() == marker {
                return lines
                    .next()
                    .filter(|entry| Self::is_managed_entry(entry, task_id))
                    .map(|entry| entry.to_string());
            }
        }
        None
    }

    fn build_entry(rendered: &RenderedSchedule) -> Result<String, String> {
        let schedule = super::cronconv::to_crontab(&rendered.cron);

        // Single-quote the program path AND every arg (embedded quotes get the '\'' dance —
        // args include data-dir paths like "~/Library/Application Support/…").
        let quote = |raw: &str| format!("'{}'", raw.replace('\'', r"'\''"));
        let quoted_program = quote(&rendered.program.to_string_lossy());
        let args = rendered
            .args
            .iter()
            .map(|arg| quote(arg))
            .collect::<Vec<_>>()
            .join(" ");
        let inner = format!("{} {} >/dev/null 2>&1", quoted_program, args);

        // Wrap the whole command in an explicit `/bin/sh -c '…'`: cron runs entries with
        // whatever SHELL= the user's crontab set above our block, and the quoting + redirects
        // here are POSIX-shell syntax (csh/tcsh would break on `2>&1` while Run Now — which
        // invokes sh directly — kept working). The wrapper makes the entry shell-agnostic.
        // '%' is escaped LAST: cron itself unescapes it before any shell sees the line.
        let command = format!("/bin/sh -c '{}'", inner.replace('\'', r"'\''")).replace('%', r"\%");

        Ok(format!("{} {}", schedule, command))
    }
}

impl SchedulerBackend for CrontabBackend {
    fn install(&self, task_id: &str, rendered: &RenderedSchedule) -> Result<(), String> {
        let entry = Self::build_entry(rendered)?;
        // Install directly in the target state — a disabled task must never be briefly armed.
        let entry = if rendered.enabled {
            entry
        } else {
            format!("{}{}", DISABLED_PREFIX, entry)
        };
        let _lock = CrontabLock::acquire(&self.lock_path)?;
        let content = Self::read()?;
        let mut result = Self::without_pair(&content, task_id);
        result.push_str(&Self::marker(task_id));
        result.push('\n');
        result.push_str(&entry);
        result.push('\n');
        self.write(&result)
    }

    fn uninstall(&self, task_id: &str) -> Result<(), String> {
        let _lock = CrontabLock::acquire(&self.lock_path)?;
        let content = Self::read()?;
        let result = Self::without_pair(&content, task_id);
        if result == content {
            return Ok(());
        }
        self.write(&result)
    }

    fn set_enabled(&self, task_id: &str, enabled: bool) -> Result<(), String> {
        let _lock = CrontabLock::acquire(&self.lock_path)?;
        let content = Self::read()?;
        let Some(entry) = Self::find_entry(&content, task_id) else {
            return Err(super::NOT_REGISTERED.to_string());
        };

        let currently_enabled = !entry.starts_with(DISABLED_PREFIX);
        if currently_enabled == enabled {
            return Ok(());
        }

        let new_entry = if enabled {
            entry.trim_start_matches(DISABLED_PREFIX).to_string()
        } else {
            format!("{}{}", DISABLED_PREFIX, entry)
        };

        let mut result = Self::without_pair(&content, task_id);
        result.push_str(&Self::marker(task_id));
        result.push('\n');
        result.push_str(&new_entry);
        result.push('\n');
        self.write(&result)
    }

    fn run_now(&self, task_id: &str) -> Result<(), String> {
        // cron has no on-demand trigger — run the entry's command directly, detached through
        // `sh -c '... &'` so the child re-parents to init and never zombies under the GUI. Under
        // Flatpak this runs on the host (the entry is a `flatpak run …` line).
        let content = Self::read()?;
        let Some(entry) = Self::find_entry(&content, task_id) else {
            return Err(super::NOT_REGISTERED.to_string());
        };
        if entry.starts_with(DISABLED_PREFIX) {
            return Err("Task is disabled".to_string());
        }
        // Strip the 5 schedule fields, keep the command.
        let command = entry
            .splitn(6, ' ')
            .nth(5)
            .ok_or("Malformed crontab entry")?;

        // Undo cron's `%` escaping (we store `%` as `\%`): cron unescapes before handing the
        // command to the shell, so bypassing cron for Run Now must do the same or a program
        // path containing `%` would run with a stray backslash.
        let command = command.replace(r"\%", "%");

        let status = host_command("sh")
            .arg("-c")
            .arg(format!("{} &", command))
            .status()
            .map_err(|e| format!("failed to start the task: {}", e))?;
        if !status.success() {
            return Err("failed to start the task".to_string());
        }
        Ok(())
    }

    fn is_installed(&self, task_id: &str) -> Result<InstallState, String> {
        let content = Self::read()?;
        match Self::find_entry(&content, task_id) {
            Some(entry) => Ok(InstallState::Installed {
                enabled: !entry.starts_with(DISABLED_PREFIX),
            }),
            None => Ok(InstallState::NotInstalled),
        }
    }

    fn inventory(&self) -> Result<Vec<Registration>, String> {
        Ok(registrations_in(&Self::read()?))
    }
}

/// Every managed pair in a crontab: a marker line and, right after it, that task's entry.
fn registrations_in(content: &str) -> Vec<Registration> {
    let mut out = Vec::new();
    let mut lines = content.lines();
    while let Some(line) = lines.next() {
        let Some(task_id) = line.trim().strip_prefix(MARKER_PREFIX) else {
            continue;
        };
        let Some(entry) = lines
            .next()
            .filter(|entry| CrontabBackend::is_managed_entry(entry, task_id))
        else {
            continue;
        };
        out.push(Registration {
            task_id: task_id.to_string(),
            enabled: !entry.starts_with(DISABLED_PREFIX),
            owned: true,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_filtering_preserves_other_lines() {
        let content = "PATH=/usr/bin\n# user comment\n0 1 * * * /usr/bin/backup\n# rclone-ui-task: abc\n0 2 * * * 'x' run-task abc --host local >/dev/null 2>&1\n";
        let filtered = CrontabBackend::without_pair(content, "abc");
        assert!(filtered.contains("PATH=/usr/bin"));
        assert!(filtered.contains("/usr/bin/backup"));
        assert!(!filtered.contains("rclone-ui-task"));
        assert!(!filtered.contains("run-task abc"));

        // Unrelated task pairs stay.
        let untouched = CrontabBackend::without_pair(content, "other");
        assert_eq!(untouched, content);
    }

    /// The inventory is one read of the crontab: every marker with its entry, enabled or off.
    #[test]
    fn the_inventory_lists_every_managed_pair() {
        let content = "PATH=/usr/bin\n# rclone-ui-task: a\n0 2 * * * run-task a cmd\n# user line\n# rclone-ui-task: b\n#off# 0 3 * * * run-task b cmd\n# rclone-ui-task: dangling\n";
        let found = registrations_in(content);
        assert_eq!(found.len(), 2);
        assert_eq!((found[0].task_id.as_str(), found[0].enabled), ("a", true));
        assert_eq!((found[1].task_id.as_str(), found[1].enabled), ("b", false));
        assert!(found.iter().all(|r| r.owned));
    }

    #[test]
    fn find_entry_returns_line_after_marker() {
        let content = "# rclone-ui-task: t1\n#off# 0 2 * * * run-task t1 cmd\n";
        let entry = CrontabBackend::find_entry(content, "t1").unwrap();
        assert!(entry.starts_with(DISABLED_PREFIX));
        assert!(CrontabBackend::find_entry(content, "t2").is_none());
    }

    #[test]
    fn foreign_line_after_marker_is_never_touched() {
        // A hand-edited crontab: the managed entry was deleted (or moved), so the line after our
        // marker is the USER'S job. It must never be deleted, disabled, or run in our task's name.
        let content = "# rclone-ui-task: abc\n0 4 * * * /usr/bin/backup-my-stuff\n";
        assert!(CrontabBackend::find_entry(content, "abc").is_none());
        let filtered = CrontabBackend::without_pair(content, "abc");
        assert!(
            filtered.contains("/usr/bin/backup-my-stuff"),
            "user line survives"
        );
        assert!(
            !filtered.contains("rclone-ui-task"),
            "dangling marker cleaned up"
        );

        // Trailing dangling marker (no following line at all).
        let filtered = CrontabBackend::without_pair("# rclone-ui-task: abc\n", "abc");
        assert!(!filtered.contains("rclone-ui-task"));
    }

    #[test]
    fn entry_is_wrapped_in_posix_shell() {
        let rendered = RenderedSchedule {
            cron: super::super::cronconv::parse("*/15 * * * *").unwrap(),
            program: std::path::PathBuf::from(
                "/Applications/Rclone UI.app/Contents/MacOS/Rclone UI",
            ),
            args: vec![
                "run-task".into(),
                "abc".into(),
                "--data-dir".into(),
                "/Users/x/Library/Application Support/com.rclone.ui".into(),
            ],
            display_name: "abc".into(),
            user_mode: true,
            enabled: true,
            max_run_seconds: 86_400,
        };
        let entry = CrontabBackend::build_entry(&rendered).unwrap();
        // Star schedule stays verbatim (cron's dom/dow star semantics).
        assert!(entry.starts_with("*/15 * * * * "));
        // Shell-agnostic: the whole command runs under an explicit POSIX shell, so a SHELL=csh
        // line in the user's crontab can't break the quoting or the redirects.
        assert!(entry.contains("/bin/sh -c '"));
        // Redirects live INSIDE the sh -c string.
        assert!(entry.trim_end().ends_with(">/dev/null 2>&1'"));
        // Inner single quotes use the '\'' dance; space-containing args stay one word.
        assert!(entry.contains(r"'\''run-task'\''"));
        assert!(entry.contains("Application Support"));
    }

    #[test]
    fn only_no_crontab_failures_read_as_empty() {
        assert!(stderr_means_no_crontab("crontab: no crontab for alice"));
        assert!(stderr_means_no_crontab("no crontab for user\n"));
        // Real failures must abort, never be treated as an empty crontab (wipe hazard).
        assert!(!stderr_means_no_crontab(
            "crontab: you (alice) are not allowed to use this program (cron.deny)"
        ));
        assert!(!stderr_means_no_crontab(
            "crontab: error renaming spool file"
        ));
    }
}
