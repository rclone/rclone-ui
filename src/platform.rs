//! OS process termination.

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
