//! The scheduler backend: each registered task gets a small state file saying whether it is on,
//! and a tick loop in the server process runs the due ones at the top of every minute. The
//! server is already running when a task comes due, so nothing has to be registered with the
//! operating system — and nothing has to be started, either: the run happens here
//! ([`super::runner::run`]).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::cronconv;
use super::jobfile;
use super::runner;
use super::storeread::DataDir;
use super::{InstallState, Registration, RenderedSchedule, SchedulerBackend, NOT_REGISTERED};
use crate::transfers::service::TransferService;

/// What registering a task leaves on disk. The schedule itself is the job file's; this is only
/// whether the tick should act on it, kept where the minute loop can read it without opening a
/// state document.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Artifact {
    enabled: bool,
    installed_at: u64,
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
                });
            }
        }
        Ok(out)
    }
}

/// Runs due tasks at the top of every minute. A task whose previous run is still going is
/// skipped by the runner itself; missed minutes are not caught up — a server that was down was
/// not going to run them anyway.
pub async fn run_ticker(dirs: DataDir, transfers: Arc<TransferService>) {
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
        for spec in jobfile::list(&dirs) {
            match read_artifact(&dirs, &spec.task_id) {
                Ok(Some(artifact)) if artifact.enabled => {}
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
            // Off the loop: a run lasts as long as its transfers do, and the next minute must
            // arrive on time regardless.
            tokio::spawn(runner::run(
                dirs.clone(),
                Arc::clone(&transfers),
                spec.task_id.clone(),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn install_set_enabled_uninstall_round_trip() {
        let root = std::env::temp_dir().join(format!("rclone-cloud-ticker-{}", std::process::id()));
        let dirs = DataDir { root: root.clone() };
        let backend = TickerBackend::new(&dirs);
        let rendered = RenderedSchedule { enabled: true };
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
            }]
        );
        let mut keep = HashSet::new();
        keep.insert("other".to_string());
        assert_eq!(crate::scheduler::sweep_backend(&backend, &keep), 1);
        assert_eq!(
            backend.is_installed("t1").unwrap(),
            InstallState::NotInstalled
        );
        backend.uninstall("t1").unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }
}
