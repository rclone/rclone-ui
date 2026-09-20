//! The daemon as a process: spawn `rclone rcd`, hold the child, wait for it to exit, and stop
//! it (SIGTERM, a grace period, then SIGKILL). Asking a binary which version it is happens here
//! too: the same thing, done once.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::{Child, Command};
use tokio::sync::oneshot;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How long a stopped daemon gets to wind down before it is killed.
const GRACE: Duration = Duration::from_secs(5);
/// How long `rclone version` may take.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// How a daemon ended.
#[derive(Clone, Debug)]
pub struct Exit {
    pub code: Option<i32>,
    /// Stopped by [`Daemon::run_until_exit`]'s stop signal, not by itself.
    pub intentional: bool,
}

/// A running daemon.
pub struct Daemon {
    pub pid: u32,
    child: Child,
}

/// Spawns `path` with `args`, `env` on top of this process's environment, and its stdio at
/// /dev/null: nothing reads it, and readiness is asked of the RC port.
pub fn spawn(path: &str, args: &[String], env: &HashMap<String, String>) -> Result<Daemon, String> {
    let mut cmd = Command::new(path);
    cmd.args(args);
    // The rc port is this server's own channel to the daemon; an inherited RCLONE_RC_* would
    // reconfigure it behind our back (RCLONE_RC_ADDR is a list: it adds a listener).
    let theirs: Vec<String> = std::env::vars()
        .map(|(key, _)| key)
        .filter(|key| key.starts_with("RCLONE_RC_"))
        .collect();
    if !theirs.is_empty() {
        log::warn!("[rclone] ignoring {} from the environment", theirs.join(", "));
        for key in &theirs {
            cmd.env_remove(key);
        }
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // The backstop: a daemon whose task is dropped does not outlive it.
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn rclone daemon: {}", e))?;
    let pid = child
        .id()
        .ok_or_else(|| "the rclone daemon exited at once".to_string())?;
    Ok(Daemon { pid, child })
}

impl Daemon {
    /// Runs until the daemon exits on its own, or `stop` fires (or is dropped): then it is asked
    /// to terminate, given [`GRACE`] to wind down, and killed.
    pub async fn run_until_exit(mut self, stop: oneshot::Receiver<()>) -> Exit {
        tokio::select! {
            status = self.child.wait() => Exit {
                code: status.ok().and_then(|s| s.code()),
                intentional: false,
            },
            _ = stop => {
                self.terminate();
                let code = match tokio::time::timeout(GRACE, self.child.wait()).await {
                    Ok(status) => status.ok().and_then(|s| s.code()),
                    Err(_) => {
                        log::warn!("[rclone] the daemon did not stop within {:?}; killing it", GRACE);
                        let _ = self.child.kill().await;
                        None
                    }
                };
                Exit { code, intentional: true }
            }
        }
    }

    /// The polite signal. Windows has no equivalent to deliver to a console process, so there
    /// the kill is the only stop.
    fn terminate(&mut self) {
        #[cfg(unix)]
        {
            // SAFETY: a signal to a pid this process spawned and has not yet reaped.
            unsafe {
                libc::kill(self.pid as libc::pid_t, libc::SIGTERM);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = self.child.start_kill();
        }
    }
}

fn parse_version(stdout: &str) -> Option<String> {
    // e.g. "rclone v1.74.3" or "rclone v1.74.0-beta.9673.d0c469c3c"
    let token = stdout.lines().next()?.split_whitespace().nth(1)?;
    Some(token.trim_start_matches('v').to_string())
}

/// Runs `<path> version` and returns the version it reports, with a Gatekeeper hint on macOS.
/// Blocks for up to [`PROBE_TIMEOUT`].
pub fn probe_version(path: &Path) -> Result<String, String> {
    let shown = path.to_string_lossy().into_owned();
    let mut cmd = std::process::Command::new(path);
    cmd.arg("version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run {}: {}", shown, e))?;
    // One line of output: the pipe cannot fill, so the wait comes first and the read after.
    let deadline = std::time::Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(_) => break,
            None if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{} did not answer `rclone version` within {} s",
                    shown,
                    PROBE_TIMEOUT.as_secs()
                ));
            }
            None => std::thread::sleep(Duration::from_millis(40)),
        }
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if output.status.success() {
        return parse_version(&String::from_utf8_lossy(&output.stdout))
            .ok_or_else(|| "Could not parse rclone version output".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        // Gatekeeper SIGKILLs a quarantined, unsigned binary.
        let quarantined = std::process::Command::new("xattr")
            .args(["-p", "com.apple.quarantine", &shown])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if quarantined {
            return Err(format!(
                "macOS blocked this binary (Gatekeeper/quarantine). Run: xattr -d com.apple.quarantine \"{}\"",
                shown
            ));
        }
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let message = stderr.trim();
    Err(if message.is_empty() {
        format!("rclone exited with code {:?}", output.status.code())
    } else {
        message.to_string()
    })
}

// The supervisor decides restarts and crash backoff from how the daemon ended, so the exit is
// a typed value. A daemon is a shell here: spawning, exiting and being stopped are all that is
// asked of it.
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn sh(script: &str) -> Daemon {
        let args = vec!["-c".to_string(), script.to_string()];
        spawn("/bin/sh", &args, &HashMap::new()).expect("the daemon spawns")
    }

    #[tokio::test]
    async fn an_exit_nobody_asked_for_is_not_intentional() {
        let daemon = sh("exit 7");
        assert!(daemon.pid > 0);
        let (_stop, stop_rx) = oneshot::channel::<()>();
        let exit = tokio::time::timeout(Duration::from_secs(10), daemon.run_until_exit(stop_rx))
            .await
            .expect("the daemon exits");
        assert_eq!(exit.code, Some(7));
        assert!(!exit.intentional);
    }

    #[tokio::test]
    async fn a_stop_we_asked_for_is_intentional_and_prompt() {
        let daemon = sh("sleep 30");
        let (stop, stop_rx) = oneshot::channel::<()>();
        let task = tokio::spawn(daemon.run_until_exit(stop_rx));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!task.is_finished(), "it runs until told otherwise");
        let started = std::time::Instant::now();
        stop.send(()).unwrap();
        let exit = tokio::time::timeout(Duration::from_secs(10), task)
            .await
            .expect("the daemon stops")
            .unwrap();
        assert!(exit.intentional);
        assert!(started.elapsed() < GRACE, "SIGTERM was enough: {:?}", started.elapsed());
    }

    #[test]
    fn the_version_is_the_second_word_of_the_first_line() {
        assert_eq!(parse_version("rclone v1.74.3\n- os/version: x"), Some("1.74.3".into()));
        assert_eq!(parse_version(""), None);
        assert!(probe_version(Path::new("/nowhere/rclone")).is_err());
    }
}
