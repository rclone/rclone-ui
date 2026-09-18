//! Process- and platform-level helpers with no app-state dependency: Flatpak sandbox
//! detection and permission checks, OS process termination.

pub fn is_flatpak() -> bool {
    std::path::Path::new("/.flatpak-info").exists() || std::env::var_os("FLATPAK_ID").is_some()
}

pub fn is_linux_mint() -> bool {
    #[cfg(not(target_os = "linux"))]
    {
        false
    }

    #[cfg(target_os = "linux")]
    {
        let paths: &[&str] = if is_flatpak() {
            &[
                "/run/host/os-release",
                "/etc/os-release",
                "/usr/lib/os-release",
            ]
        } else {
            &["/etc/os-release", "/usr/lib/os-release"]
        };

        for path in paths {
            if let Ok(contents) = std::fs::read_to_string(path) {
                return contents.lines().any(|line| {
                    let line = line.trim();
                    line == "ID=linuxmint" || line == "ID=\"linuxmint\""
                });
            }
        }

        false
    }
}

/// The single Flatpak permission gate: the app quits at startup unless it holds BOTH writable
/// host filesystem access (rclone needs it) AND host-spawn access (the scheduler needs it). This
/// all-or-nothing check is why no other Flatpak permission checks exist elsewhere — any running
/// instance is guaranteed to have full permissions.
pub fn has_flatpak_permissions() -> bool {
    if !is_flatpak() {
        return true;
    }
    has_host_filesystem() && flatpak_can_spawn_host()
}

fn has_host_filesystem() -> bool {
    let Ok(contents) = std::fs::read_to_string("/.flatpak-info") else {
        return false;
    };

    let mut in_context = false;

    for line in contents.lines() {
        let line = line.trim();

        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        if line.starts_with('[') && line.ends_with(']') {
            in_context = line == "[Context]";
            continue;
        }

        if !in_context {
            continue;
        }

        let Some((key, value)) = line.split_once('=') else {
            continue;
        };

        if key.trim() != "filesystems" {
            continue;
        }

        for raw in value.split(';') {
            let item = raw.trim();

            if item.is_empty() {
                continue;
            }

            // Explicit negative override, e.g. !host
            if item == "!host" || item.starts_with("!host:") {
                return false;
            }

            // Writable host access
            if item == "host" || item == "host:rw" || item == "host:create" {
                return true;
            }

            // Read-only host access is not enough for full rclone filesystem usage
            if item == "host:ro" {
                return false;
            }
        }
    }

    false
}

/// Whether the sandbox can spawn processes on the host (`flatpak-spawn --host`), which the
/// scheduler needs to register OS cron jobs. Always true off Flatpak. Granted by
/// `--talk-name=org.freedesktop.Flatpak`, which appears in /.flatpak-info under
/// `[Session Bus Policy]` as `org.freedesktop.Flatpak=talk` (or `own`).
pub fn flatpak_can_spawn_host() -> bool {
    if !is_flatpak() {
        return true;
    }
    let Ok(contents) = std::fs::read_to_string("/.flatpak-info") else {
        return false;
    };
    flatpak_info_grants_host_spawn(&contents)
}

/// True when the parsed /.flatpak-info grants `org.freedesktop.Flatpak` in `[Session Bus Policy]`.
fn flatpak_info_grants_host_spawn(contents: &str) -> bool {
    let mut in_session_bus = false;
    for line in contents.lines() {
        let line = line.trim();

        if line.starts_with('[') && line.ends_with(']') {
            in_session_bus = line == "[Session Bus Policy]";
            continue;
        }

        if !in_session_bus {
            continue;
        }

        if let Some((key, value)) = line.split_once('=') {
            if key.trim() == "org.freedesktop.Flatpak" {
                let policy = value.trim();
                return policy == "talk" || policy == "own";
            }
        }
    }

    false
}

#[cfg(test)]
mod flatpak_tests {
    use super::flatpak_info_grants_host_spawn;

    #[test]
    fn detects_granted_talk_permission() {
        let info = "[Application]\nname=com.rcloneui.RcloneUI\n\n[Session Bus Policy]\norg.freedesktop.Flatpak=talk\norg.freedesktop.Notifications=talk\n";
        assert!(flatpak_info_grants_host_spawn(info));
    }

    #[test]
    fn own_policy_also_counts() {
        let info = "[Session Bus Policy]\norg.freedesktop.Flatpak=own\n";
        assert!(flatpak_info_grants_host_spawn(info));
    }

    #[test]
    fn absent_or_other_sections_do_not_count() {
        // Permission not listed at all.
        let info = "[Session Bus Policy]\norg.freedesktop.Notifications=talk\n";
        assert!(!flatpak_info_grants_host_spawn(info));
        // Same key but in a different section must not match.
        let wrong_section = "[System Bus Policy]\norg.freedesktop.Flatpak=talk\n";
        assert!(!flatpak_info_grants_host_spawn(wrong_section));
        // Explicit 'none' policy.
        let none = "[Session Bus Policy]\norg.freedesktop.Flatpak=none\n";
        assert!(!flatpak_info_grants_host_spawn(none));
    }
}

/// Ends a process and everything under it.
///
/// `timeout_ms` is the grace period between the polite signal and the hard one, and it is a Unix
/// notion: there the process gets SIGTERM, up to this long to wind down, then SIGKILL. Windows
/// has no equivalent to deliver to a console process, so `taskkill /F /T` ends the tree at once
/// and the grace period does not apply — a caller that needs the daemon to finish what it is
/// doing must ask it to quit (`/core/quit`) before reaching for this.
pub fn kill_pid(pid: u32, timeout_ms: Option<u64>) -> Result<(), String> {
    #[cfg(any(
        target_os = "macos",
        target_os = "linux",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd"
    ))]
    {
        use std::time::{Duration, Instant};

        let timeout = timeout_ms.unwrap_or(5000);
        let pid_str = pid.to_string();

        // Try graceful termination first
        let _ = std::process::Command::new("kill")
            .args(&["-TERM", &pid_str])
            .status();

        let deadline = Instant::now() + Duration::from_millis(timeout);
        while Instant::now() < deadline {
            // Check if process still exists: kill -0 <pid>
            let alive = std::process::Command::new("kill")
                .args(&["-0", &pid_str])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if !alive {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        // Force kill
        let _ = std::process::Command::new("kill")
            .args(&["-KILL", &pid_str])
            .status();

        // Final check (best effort)
        let alive = std::process::Command::new("kill")
            .args(&["-0", &pid_str])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if alive {
            return Err("Failed to terminate process".to_string());
        }

        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let _ = timeout_ms;
        let pid_str = pid.to_string();

        let _ = std::process::Command::new("taskkill")
            .args(&["/PID", &pid_str, "/F", "/T"])
            .status();

        let output = std::process::Command::new("tasklist")
            .args(&["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
            .output()
            .map_err(|e| e.to_string())?;
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        if !stdout.trim().is_empty()
            && stdout.contains(&pid_str)
            && !stdout.contains("No tasks are running")
        {
            return Err("Failed to terminate process".to_string());
        }

        return Ok(());
    }

    #[cfg(not(any(
        target_os = "macos",
        target_os = "linux",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd",
        target_os = "windows"
    )))]
    {
        let _ = (pid, timeout_ms);
        Err("Unsupported platform".to_string())
    }
}
