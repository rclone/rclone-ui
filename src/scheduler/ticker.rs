//! The in-process scheduler backend: instead of an OS artifact, each registered task gets a
//! small state file, and a tick loop in the server process fires due tasks at the top of each
//! minute by spawning `<this binary> run-task …` — the very same child the OS schedulers spawn,
//! so `runner.rs` (locking, history, webhooks, SIGTERM handling) is reused unchanged.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::cronconv;
use super::jobfile;
use super::storeread::DataDir;
use super::{InstallState, Registration, RenderedSchedule, SchedulerBackend, NOT_REGISTERED};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Artifact {
    enabled: bool,
    installed_at: u64,
    program: String,
    args: Vec<String>,
}

pub struct TickerBackend {
    dirs: DataDir,
}

fn ticker_dir(dirs: &DataDir) -> PathBuf {
    dirs.root.join("scheduler").join("ticker")
}

fn artifact_path(dirs: &DataDir, task_id: &str) -> PathBuf {
    ticker_dir(dirs).join(format!("{}.json", task_id))
}

fn read_artifact(dirs: &DataDir, task_id: &str) -> Result<Option<Artifact>, String> {
    match std::fs::read(artifact_path(dirs, task_id)) {
        Ok(raw) => serde_json::from_slice(&raw)
            .map(Some)
            .map_err(|e| format!("invalid ticker artifact for {}: {}", task_id, e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!(
            "failed to read ticker artifact for {}: {}",
            task_id, e
        )),
    }
}

fn write_artifact(dirs: &DataDir, task_id: &str, artifact: &Artifact) -> Result<(), String> {
    let path = artifact_path(dirs, task_id);
    std::fs::create_dir_all(ticker_dir(dirs)).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(artifact).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn spawn_child(program: &str, args: &[String]) -> Result<(), String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to start the task runner: {}", e))?;
    let label = args.get(1).cloned().unwrap_or_default();
    // Reap it off the loop so it never becomes a zombie; the runner records its own history.
    crate::rt::spawn_blocking(move || match child.wait() {
        Ok(status) => log::info!("[ticker] run-task {} exited with {}", label, status),
        Err(e) => log::warn!("[ticker] run-task {} could not be awaited: {}", label, e),
    });
    Ok(())
}

impl TickerBackend {
    pub fn new(dirs: &DataDir) -> Self {
        TickerBackend { dirs: dirs.clone() }
    }
}

impl SchedulerBackend for TickerBackend {
    fn install(&self, task_id: &str, rendered: &RenderedSchedule) -> Result<(), String> {
        write_artifact(
            &self.dirs,
            task_id,
            &Artifact {
                enabled: rendered.enabled,
                installed_at: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
                program: rendered.program.to_string_lossy().into_owned(),
                args: rendered.args.clone(),
            },
        )
    }

    fn uninstall(&self, task_id: &str) -> Result<(), String> {
        match std::fs::remove_file(artifact_path(&self.dirs, task_id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!(
                "failed to remove ticker artifact for {}: {}",
                task_id, e
            )),
        }
    }

    fn set_enabled(&self, task_id: &str, enabled: bool) -> Result<(), String> {
        let mut artifact =
            read_artifact(&self.dirs, task_id)?.ok_or_else(|| NOT_REGISTERED.to_string())?;
        artifact.enabled = enabled;
        write_artifact(&self.dirs, task_id, &artifact)
    }

    fn run_now(&self, task_id: &str) -> Result<(), String> {
        let artifact =
            read_artifact(&self.dirs, task_id)?.ok_or_else(|| NOT_REGISTERED.to_string())?;
        spawn_child(&artifact.program, &artifact.args)
    }

    fn is_installed(&self, task_id: &str) -> Result<InstallState, String> {
        Ok(match read_artifact(&self.dirs, task_id)? {
            Some(artifact) => InstallState::Installed {
                enabled: artifact.enabled,
            },
            None => InstallState::NotInstalled,
        })
    }

    fn inventory(&self) -> Result<Vec<Registration>, String> {
        let entries = match std::fs::read_dir(ticker_dir(&self.dirs)) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("failed to read the ticker state: {}", e)),
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".json") else {
                continue;
            };
            if let Some(artifact) = read_artifact(&self.dirs, id)? {
                out.push(Registration {
                    task_id: id.to_string(),
                    enabled: artifact.enabled,
                    owned: true,
                });
            }
        }
        Ok(out)
    }
}

/// Fires due tasks at the top of every minute. Overlapping fires of one task are rejected by
/// the runner's own lock; missed minutes are not caught up (the same policy as macOS).
pub async fn run_ticker(dirs: DataDir) {
    use chrono::{Datelike, Timelike};
    loop {
        let now = chrono::Local::now();
        let wait = 60 - now.second() as u64;
        tokio::time::sleep(Duration::from_secs(wait) + Duration::from_millis(500)).await;

        let now = chrono::Local::now();
        let (minute, hour, dom, month, dow) = (
            now.minute() as u16,
            now.hour() as u16,
            now.day() as u16,
            now.month() as u16,
            now.weekday().num_days_from_sunday() as u16,
        );
        for spec in jobfile::list(&dirs, "local") {
            let artifact = match read_artifact(&dirs, &spec.task_id) {
                Ok(Some(artifact)) if artifact.enabled => artifact,
                Ok(_) => continue,
                Err(e) => {
                    log::warn!("[ticker] {}", e);
                    continue;
                }
            };
            let Ok(cron) = cronconv::parse(&spec.cron) else {
                continue;
            };
            if !cronconv::matches(&cron, minute, hour, dom, month, dow) {
                continue;
            }
            log::info!("[ticker] firing {} ({})", spec.name, spec.task_id);
            if let Err(e) = spawn_child(&artifact.program, &artifact.args) {
                log::error!("[ticker] {}", e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn install_set_enabled_uninstall_round_trip() {
        let root = std::env::temp_dir().join(format!("rcloneui-ticker-{}", std::process::id()));
        let dirs = DataDir { root: root.clone() };
        let backend = TickerBackend::new(&dirs);
        let rendered = RenderedSchedule {
            cron: cronconv::parse("*/5 * * * *").unwrap(),
            program: PathBuf::from("/bin/true"),
            args: vec!["run-task".into(), "t1".into()],
            display_name: "t1".into(),
            user_mode: false,
            enabled: true,
            max_run_seconds: 60,
        };
        assert_eq!(
            backend.is_installed("t1").unwrap(),
            InstallState::NotInstalled
        );
        assert_eq!(
            backend.set_enabled("t1", false).unwrap_err(),
            NOT_REGISTERED
        );
        backend.install("t1", &rendered).unwrap();
        assert_eq!(
            backend.is_installed("t1").unwrap(),
            InstallState::Installed { enabled: true }
        );
        backend.set_enabled("t1", false).unwrap();
        assert_eq!(
            backend.is_installed("t1").unwrap(),
            InstallState::Installed { enabled: false }
        );
        assert_eq!(
            backend.inventory().unwrap(),
            vec![Registration {
                task_id: "t1".into(),
                enabled: false,
                owned: true,
            }]
        );
        let mut keep = HashSet::new();
        keep.insert("other".to_string());
        let backends: Vec<Box<dyn SchedulerBackend>> = vec![Box::new(TickerBackend::new(&dirs))];
        assert_eq!(crate::scheduler::sweep_backends(&backends, &keep), 1);
        assert_eq!(
            backend.is_installed("t1").unwrap(),
            InstallState::NotInstalled
        );
        backend.uninstall("t1").unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }
}
