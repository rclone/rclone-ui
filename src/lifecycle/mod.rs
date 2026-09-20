//! The orchestrator: resolve a binary, spawn `rclone rcd`, wait for it, restart it on request
//! (coalescing bursts), restart it after a crash with backoff, tell the transfers service when
//! it went down, and run the startup mounts.
//!
//! Nothing here resolves a configuration file. The daemon inherits this process's environment,
//! so `RCLONE_CONFIG`, `XDG_CONFIG_HOME` and `RCLONE_CONFIG_PASS` reach rclone exactly as the
//! operator set them, and rclone picks its own config.

pub mod binary;
pub mod install;
pub mod mounts;
pub mod process;
pub mod scheduler_reconcile;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tokio::sync::{mpsc, oneshot, watch};

use crate::bus::Bus;
use crate::datadir::DataDir;
use crate::notifications::notify;
use crate::rc;
use crate::state::{Settings, StateStore};
use crate::transfers::service::TransferService;
use crate::DaemonTarget;
use process::Exit;

const MAX_ATTEMPTS: u32 = 5;
const READINESS_TIMEOUT: Duration = Duration::from_secs(15);
/// A daemon that stayed up this long was healthy: a later crash starts a new failure streak
/// instead of adding to the previous one.
const CRASH_GRACE: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Phase {
    Stopped,
    Resolving,
    /// First-time provisioning of a managed rclone.
    Downloading {
        version: String,
    },
    /// The server's own rclone is being auto-updated.
    Updating {
        from: String,
        to: String,
    },
    Starting,
    Ready {
        pid: u32,
        port: u16,
        version: String,
    },
    Failed {
        error: String,
        attempts: u32,
    },
}

/// The daemon this supervisor spawned, while it runs: how to stop it, and the task that holds
/// it until it exits.
struct Running {
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<Exit>,
}

pub struct Supervisor {
    dirs: DataDir,
    bus: Bus,
    daemon: Mutex<Option<Running>>,
    store: Arc<StateStore>,
    /// The binary `--rclone-path` names: never replaced by a custom one, never auto-updated.
    pinned: Option<PathBuf>,
    phase: watch::Sender<Phase>,
    /// Where the daemon listens, for everybody who talks to it (`AppState::local_daemon`, the
    /// transfer service); `None` while it is down.
    target: watch::Sender<Option<DaemonTarget>>,
    restart_tx: mpsc::UnboundedSender<()>,
    shutting_down: AtomicBool,
    /// The proxy URL whose connectivity was already probed (and answered) this process.
    proxy_probed: Mutex<Option<String>>,
    /// Told when the daemon goes down: what it was transferring went with it.
    transfers: Arc<TransferService>,
    /// The startup mount pass of the daemon that is up, so a restart can cancel it.
    mounting: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Supervisor {
    /// Starts the orchestrator on the current tokio runtime.
    pub fn spawn(
        dirs: DataDir,
        bus: Bus,
        store: Arc<StateStore>,
        pinned: Option<PathBuf>,
        transfers: Arc<TransferService>,
        target: watch::Sender<Option<DaemonTarget>>,
    ) -> Arc<Supervisor> {
        let (phase, _) = watch::channel(Phase::Stopped);
        let (restart_tx, restart_rx) = mpsc::unbounded_channel();
        let supervisor = Arc::new(Supervisor {
            dirs,
            bus,
            daemon: Mutex::new(None),
            store,
            pinned,
            phase,
            target,
            restart_tx,
            shutting_down: AtomicBool::new(false),
            proxy_probed: Mutex::new(None),
            transfers,
            mounting: Mutex::new(None),
        });
        tokio::spawn(run_loop(Arc::clone(&supervisor), restart_rx));
        supervisor
    }

    pub fn phase(&self) -> Phase {
        self.phase.borrow().clone()
    }

    pub fn pinned(&self) -> Option<&std::path::Path> {
        self.pinned.as_deref()
    }

    pub fn request_restart(&self) {
        let _ = self.restart_tx.send(());
    }

    /// Stops the daemon for good (process exit). The loop sees the intentional exit and parks.
    pub async fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.stop_daemon().await;
        self.set_phase(Phase::Stopped);
    }

    fn set_phase(&self, phase: Phase) {
        self.bus.publish("lifecycle.phase", &phase);
        self.phase.send_replace(phase);
    }

    /// The daemon is down: nobody is to talk to it, and its transfers went with it.
    fn daemon_gone(&self) -> Option<Running> {
        self.target.send_replace(None);
        self.transfers.daemon_stopped();
        self.daemon.lock().unwrap().take()
    }

    /// Stops the daemon and waits until it is gone.
    async fn stop_daemon(&self) {
        let Some(mut running) = self.daemon_gone() else {
            return;
        };
        if let Some(stop) = running.stop.take() {
            let _ = stop.send(());
        }
        if let Err(e) = (&mut running.task).await {
            log::warn!("[lifecycle] the daemon task failed: {}", e);
        }
    }

    async fn start_once(&self) -> Result<mpsc::UnboundedReceiver<Exit>, String> {
        // Reject a second daemon instead of orphaning the first.
        if self.daemon.lock().unwrap().is_some() {
            return Err("an rclone daemon is already running".to_string());
        }
        self.set_phase(Phase::Resolving);
        let found = binary::resolve(
            &self.dirs,
            &self.bus,
            &self.store,
            self.pinned.as_deref(),
            &|phase| self.set_phase(phase),
        )
        .await?;

        // The daemon is told about its environment only the proxy and the limits. Its config
        // file is rclone's business: whatever `RCLONE_CONFIG`/`XDG_CONFIG_HOME` this process was
        // given is inherited untouched, and rclone resolves the rest.
        let mut env = build_run_env(&self.store.settings());

        // Informational proxy check (the env vars come from build_run_env regardless): one
        // request through the proxy, once per proxy URL. It costs up to 10 s and reaches a third
        // party, so a restart with the same proxy (crash recovery, a settings change) skips it.
        if let Some(proxy) = env.get("https_proxy").cloned().filter(|p| !p.is_empty()) {
            let probed = self.proxy_probed.lock().unwrap().as_deref() == Some(proxy.as_str());
            if !probed {
                if let Err(error) = crate::http::test_proxy_connection(&proxy).await {
                    log::warn!("[lifecycle] the proxy {} is unreachable: {}", proxy, error);
                }
                *self.proxy_probed.lock().unwrap() = Some(proxy);
            }
        }

        self.set_phase(Phase::Starting);
        let port = rc::pick_port()?;
        let user = rc::random_token();
        let pass = rc::random_token();
        // Through the environment, not argv: a process list is readable by other local processes.
        env.insert("RCLONE_RC_USER".to_string(), user.clone());
        env.insert("RCLONE_RC_PASS".to_string(), pass.clone());

        let args: Vec<String> = [
            "rcd",
            "--rc-addr",
            &format!("127.0.0.1:{}", port),
            "--rc-serve",
            // The daemon's stdin is /dev/null, so an encrypted config with no password in the
            // environment would have rclone prompt into EOF and report a panic. The password is
            // passed with `RCLONE_CONFIG_PASS`, or not at all.
            "--ask-password=false",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();

        log::info!("[lifecycle] starting {} on port {}", found.path, port);
        let daemon = process::spawn(&found.path, &args, &env)?;
        let pid = daemon.pid;
        let (stop_tx, stop_rx) = oneshot::channel();
        let (exit_tx, exit_rx) = mpsc::unbounded_channel::<Exit>();
        let task = tokio::spawn(async move {
            let exit = daemon.run_until_exit(stop_rx).await;
            let _ = exit_tx.send(exit.clone());
            exit
        });
        *self.daemon.lock().unwrap() = Some(Running {
            stop: Some(stop_tx),
            task,
        });

        let target = DaemonTarget {
            base_url: format!("http://127.0.0.1:{}", port),
            user: Some(user),
            pass: Some(pass),
        };
        let client = target.client();
        client
            .wait_ready(READINESS_TIMEOUT, || {
                let slot = self.daemon.lock().unwrap();
                slot.as_ref()
                    .is_none_or(|running| running.task.is_finished())
                    .then(|| "rclone daemon exited during startup".to_string())
            })
            .await?;
        let version = client
            .call("/core/version", &json!({}))
            .await
            .ok()
            .and_then(|v| {
                v["version"]
                    .as_str()
                    .map(|s| s.trim_start_matches('v').to_string())
            })
            .unwrap_or_default();

        self.target.send_replace(Some(target));
        self.set_phase(Phase::Ready { pid, port, version });

        // Off the critical path: the scheduler reconcile and startup mounts.
        {
            let (dirs, store) = (self.dirs.clone(), Arc::clone(&self.store));
            tokio::spawn(async move {
                scheduler_reconcile::reconcile(&dirs, &store).await;
            });
        }
        {
            let (dirs, store) = (self.dirs.clone(), Arc::clone(&self.store));
            // A mount pass belongs to the daemon that was up when it started: a crash-looping
            // one would otherwise stack passes, each retrying against a port that is gone.
            let previous = self
                .mounting
                .lock()
                .unwrap()
                .replace(tokio::spawn(async move {
                    mounts::startup_mounts(&dirs, &store, &client).await
                }));
            if let Some(previous) = previous {
                previous.abort();
            }
        }
        Ok(exit_rx)
    }

    async fn crashed(&self, exit: &Exit, attempts: u32) {
        let body = match exit.code {
            Some(code) => format!("rclone exited unexpectedly (code {})", code),
            None => "rclone exited unexpectedly".to_string(),
        };
        log::error!("[lifecycle] {} (attempt {})", body, attempts);
        // One notification per streak, and one more when it reaches the limit: a daemon dying
        // every few seconds must not page every few seconds.
        if attempts == 1 {
            notify(
                &self.dirs,
                "rclone.crashed",
                "Rclone daemon crashed",
                &body,
                json!({ "exitCode": exit.code }),
            );
        } else if attempts == MAX_ATTEMPTS {
            notify(
                &self.dirs,
                "rclone.crashed",
                "Rclone daemon keeps crashing",
                &format!("{} — {} times in a row", body, attempts),
                json!({ "exitCode": exit.code, "attempts": attempts }),
            );
        }
        self.set_phase(Phase::Failed {
            error: body,
            attempts,
        });
    }
}

fn backoff(attempts: u32) -> Duration {
    Duration::from_secs((2u64.pow(attempts.min(5))).min(30))
}

/// The requests queued behind the one that woke us are the same request.
fn coalesce(rx: &mut mpsc::UnboundedReceiver<()>) {
    while rx.try_recv().is_ok() {}
}

/// Parks until a restart is requested (or the backoff passes when `timeout` is given).
/// Returns `false` when the supervisor is gone.
async fn wait_for_restart(rx: &mut mpsc::UnboundedReceiver<()>, timeout: Option<Duration>) -> bool {
    let request = match timeout {
        Some(delay) => tokio::select! {
            req = rx.recv() => req,
            _ = tokio::time::sleep(delay) => return true,
        },
        None => rx.recv().await,
    };
    match request {
        Some(()) => {
            coalesce(rx);
            true
        }
        None => false,
    }
}

async fn run_loop(supervisor: Arc<Supervisor>, mut restart_rx: mpsc::UnboundedReceiver<()>) {
    // Consecutive failures: failed starts, and crashes of a daemon that never made it past
    // CRASH_GRACE. A successful start alone does not reset it — a daemon that comes up and dies
    // seconds later would otherwise restart every two seconds forever, never backing off.
    let mut attempts: u32 = 0;
    loop {
        if supervisor.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        match supervisor.start_once().await {
            Ok(mut exit_rx) => {
                let started_at = Instant::now();
                tokio::select! {
                    request = restart_rx.recv() => {
                        let Some(()) = request else { return };
                        log::info!("[lifecycle] restart requested");
                        if started_at.elapsed() >= CRASH_GRACE {
                            attempts = 0;
                        }
                        supervisor.stop_daemon().await;
                        coalesce(&mut restart_rx);
                    }
                    exit = exit_rx.recv() => {
                        let exit = exit.unwrap_or(Exit { code: None, intentional: true });
                        supervisor.daemon_gone();
                        if exit.intentional || supervisor.shutting_down.load(Ordering::SeqCst) {
                            // Stopped on purpose: stay down until something asks for a daemon again.
                            supervisor.set_phase(Phase::Stopped);
                            attempts = 0;
                            if !wait_for_restart(&mut restart_rx, None).await {
                                return;
                            }
                        } else {
                            if started_at.elapsed() >= CRASH_GRACE {
                                attempts = 0;
                            }
                            attempts = attempts.saturating_add(1);
                            supervisor.crashed(&exit, attempts).await;
                            if !wait_for_restart(&mut restart_rx, Some(backoff(attempts))).await {
                                return;
                            }
                        }
                    }
                }
            }
            Err(error) => {
                supervisor.stop_daemon().await;
                attempts = attempts.saturating_add(1);
                log::error!("[lifecycle] start failed (attempt {}): {}", attempts, error);
                supervisor.set_phase(Phase::Failed { error, attempts });
                if !wait_for_restart(&mut restart_rx, Some(backoff(attempts))).await {
                    return;
                }
            }
        }
    }
}

/// The environment the daemon is started with, on top of the one this process already has.
///
/// The proxy and the limits belong here. Nothing about rclone's configuration file does: the
/// server does not decide where that lives, so `RCLONE_CONFIG` and friends are left exactly as
/// the operator set them and rclone resolves its own config (see the module doc).
pub fn build_run_env(settings: &Settings) -> HashMap<String, String> {
    let mut env = HashMap::new();

    if let Some(proxy) = settings.active_proxy() {
        for key in ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"] {
            env.insert(key.to_string(), proxy.url.trim().to_string());
        }
        if !proxy.ignored_hosts.is_empty() {
            let joined = proxy.ignored_hosts.join(",");
            env.insert("no_proxy".to_string(), joined.clone());
            env.insert("NO_PROXY".to_string(), joined);
        }
    }

    // Only what is set here: left out, the operator's own RCLONE_BWLIMIT / RCLONE_TPSLIMIT
    // still reach the daemon. `--tpslimit` is read once, at start, which is why it is here.
    let limits = &settings.limits;
    if !limits.bw_limit.trim().is_empty() {
        env.insert(
            "RCLONE_BWLIMIT".to_string(),
            limits.bw_limit.trim().to_string(),
        );
    }
    if limits.tps_limit.is_finite() && limits.tps_limit > 0.0 {
        env.insert("RCLONE_TPSLIMIT".to_string(), limits.tps_limit.to_string());
        if limits.tps_limit_burst > 0 {
            env.insert(
                "RCLONE_TPSLIMIT_BURST".to_string(),
                limits.tps_limit_burst.to_string(),
            );
        }
    }

    env
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{Limits, ProxySettings};

    #[test]
    fn limits_reach_the_daemon_only_when_they_are_set() {
        let unset = build_run_env(&Settings::default());
        for key in ["RCLONE_BWLIMIT", "RCLONE_TPSLIMIT", "RCLONE_TPSLIMIT_BURST"] {
            assert!(
                !unset.contains_key(key),
                "{} is the operator's when unset",
                key
            );
        }
        let settings = Settings {
            limits: Limits {
                bw_limit: " 10M:5M ".into(),
                tps_limit: 2.5,
                tps_limit_burst: 4,
            },
            ..Default::default()
        };
        let env = build_run_env(&settings);
        assert_eq!(env["RCLONE_BWLIMIT"], "10M:5M");
        assert_eq!(env["RCLONE_TPSLIMIT"], "2.5");
        assert_eq!(env["RCLONE_TPSLIMIT_BURST"], "4");
        // A burst means nothing without a limit.
        let burst_only = build_run_env(&Settings {
            limits: Limits {
                tps_limit_burst: 4,
                ..Default::default()
            },
            ..Default::default()
        });
        assert!(!burst_only.contains_key("RCLONE_TPSLIMIT_BURST"));
    }

    /// The daemon's environment says nothing about rclone's config file. Setting any of these
    /// would override what the operator put in the environment we are inherited from, which is
    /// the one thing this design must never do.
    #[test]
    fn the_daemon_environment_says_nothing_about_the_config_file() {
        let settings = Settings {
            proxy: Some(ProxySettings {
                url: "http://proxy:8080".into(),
                ignored_hosts: vec!["localhost".into()],
            }),
            ..Default::default()
        };
        let env = build_run_env(&settings);
        assert_eq!(
            env.get("http_proxy").map(String::as_str),
            Some("http://proxy:8080")
        );
        assert_eq!(env.get("no_proxy").map(String::as_str), Some("localhost"));
        for key in [
            "RCLONE_CONFIG",
            "RCLONE_CONFIG_DIR",
            "RCLONE_ASK_PASSWORD",
            "RCLONE_CONFIG_PASS",
            "RCLONE_CONFIG_PASS_COMMAND",
        ] {
            assert!(
                !env.contains_key(key),
                "{} must be left to the operator",
                key
            );
        }
    }
}
