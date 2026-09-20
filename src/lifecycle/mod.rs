//! The orchestrator: resolve a binary, spawn `rclone rcd`, wait for it, restart it on request
//! (coalescing bursts), restart it after a crash
//! with backoff, tell the transfers service when it went down, and run the startup mounts.
//!
//! Nothing here resolves a configuration file. The daemon inherits this process's environment,
//! so `RCLONE_CONFIG`, `XDG_CONFIG_HOME` and `RCLONE_CONFIG_PASS` reach rclone exactly as the
//! operator set them, and rclone picks its own config.

pub mod mounts;
pub mod resolve;
pub mod scheduler_reconcile;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tokio::sync::{mpsc, watch};

use crate::bus::Bus;
use crate::datadir::DataDir;
use crate::notifications::notify;
use crate::rc::{self, RcClient};
use crate::state::{Settings, StateStore};
use crate::transfers::service::TransferService;
use crate::zookeeper::{self, DaemonState, RcloneEvent};

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
        /// The binary was updated during this start.
        updated: bool,
    },
    Failed {
        error: String,
        attempts: u32,
    },
}

/// Where the managed daemon listens and how to authenticate to it.
#[derive(Clone, Debug)]
pub struct RcTarget {
    pub base_url: String,
    pub user: String,
    pub pass: String,
}

impl RcTarget {
    pub fn client(&self) -> RcClient {
        RcClient::new(
            self.base_url.clone(),
            Some(self.user.clone()),
            Some(self.pass.clone()),
        )
    }
}

pub struct Options {
    /// Use this binary instead of resolving/downloading one.
    pub rclone_path_override: Option<PathBuf>,
}

pub struct Supervisor {
    dirs: DataDir,
    bus: Bus,
    /// The daemon this supervisor spawned, while it runs (`zookeeper::spawn_rclone_with`).
    daemon: Arc<Mutex<DaemonState>>,
    store: Arc<StateStore>,
    options: Options,
    phase: watch::Sender<Phase>,
    target: RwLock<Option<RcTarget>>,
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
        options: Options,
        transfers: Arc<TransferService>,
    ) -> Arc<Supervisor> {
        let (phase, _) = watch::channel(Phase::Stopped);
        let (restart_tx, restart_rx) = mpsc::unbounded_channel();
        let supervisor = Arc::new(Supervisor {
            dirs,
            bus,
            daemon: Arc::new(Mutex::new(DaemonState::default())),
            store,
            options,
            phase,
            target: RwLock::new(None),
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

    pub fn target(&self) -> Option<RcTarget> {
        self.target.read().unwrap().clone()
    }

    /// The binary `--rclone-path` names: never replaced by a custom one, never auto-updated.
    pub fn pinned(&self) -> Option<&std::path::Path> {
        self.options.rclone_path_override.as_deref()
    }

    pub fn request_restart(&self) {
        let _ = self.restart_tx.send(());
    }

    /// Stops the daemon for good (process exit). The loop sees the intentional close and parks.
    pub async fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.stop_daemon().await;
        self.set_phase(Phase::Stopped);
    }

    fn set_phase(&self, phase: Phase) {
        self.bus.publish("lifecycle.phase", &phase);
        self.phase.send_replace(phase);
    }

    async fn stop_daemon(&self) {
        *self.target.write().unwrap() = None;
        self.transfers.daemon_stopped();
        let daemon = Arc::clone(&self.daemon);
        match tokio::task::spawn_blocking(move || {
            zookeeper::kill_rclone_daemon(&daemon, Some(5000))
        })
        .await
        {
            Ok(Err(e)) => log::warn!("[lifecycle] failed to stop the daemon: {}", e),
            Err(e) => log::warn!("[lifecycle] failed to stop the daemon: {}", e),
            Ok(Ok(_)) => {}
        }
    }

    async fn start_once(&self) -> Result<mpsc::UnboundedReceiver<RcloneEvent>, String> {
        self.set_phase(Phase::Resolving);
        let found = resolve::resolve_binary(
            &self.dirs,
            &self.bus,
            &self.store,
            self.options.rclone_path_override.as_deref(),
            |version| self.set_phase(Phase::Downloading { version }),
        )
        .await?;
        // It is replaced where it lives, so the path to run does not change.
        let updated = resolve::maybe_auto_update(
            &self.dirs,
            &self.bus,
            &self.store,
            &found,
            |from, to| self.set_phase(Phase::Updating { from, to }),
        )
        .await
        .is_some();
        let path = found.path;

        // The daemon is told about its environment only the proxy and the limits. Its config file
        // is rclone's business: whatever `RCLONE_CONFIG`/`XDG_CONFIG_HOME` this process was given
        // is inherited untouched, and rclone resolves the rest.
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
            // environment would have rclone prompt into EOF and report a panic. This turns that
            // Passing a password is done using `RCLONE_CONFIG_PASS`.
            "--ask-password=false",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();

        let (close_tx, close_rx) = mpsc::unbounded_channel::<RcloneEvent>();
        log::info!("[lifecycle] starting {} on port {}", path, port);
        let pid = zookeeper::spawn_rclone_with(
            &self.daemon,
            path,
            args,
            env,
            Box::new(move |event| {
                let _ = close_tx.send(event);
            }),
        )?;

        let target = RcTarget {
            base_url: format!("http://127.0.0.1:{}", port),
            user,
            pass,
        };
        let client = target.client();
        let daemon = Arc::clone(&self.daemon);
        client
            .wait_ready(READINESS_TIMEOUT, || {
                let state = daemon.lock().unwrap();
                (state.pid != Some(pid)).then(|| "rclone daemon exited during startup".to_string())
            })
            .await
            ?;
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

        *self.target.write().unwrap() = Some(target);
        self.set_phase(Phase::Ready {
            pid,
            port,
            version,
            updated,
        });

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
        Ok(close_rx)
    }

    async fn crashed(&self, event: &RcloneEvent, attempts: u32) {
        let body = match event.code {
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
                json!({ "exitCode": event.code }),
            );
        } else if attempts == MAX_ATTEMPTS {
            notify(
                &self.dirs,
                "rclone.crashed",
                "Rclone daemon keeps crashing",
                &format!("{} — {} times in a row", body, attempts),
                json!({ "exitCode": event.code, "attempts": attempts }),
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
async fn wait_for_restart(
    rx: &mut mpsc::UnboundedReceiver<()>,
    timeout: Option<Duration>,
) -> bool {
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

async fn run_loop(
    supervisor: Arc<Supervisor>,
    mut restart_rx: mpsc::UnboundedReceiver<()>,
) {
    // Consecutive failures: failed starts, and crashes of a daemon that never made it past
    // CRASH_GRACE. A successful start alone does not reset it — a daemon that comes up and dies
    // seconds later would otherwise restart every two seconds forever, never backing off.
    let mut attempts: u32 = 0;
    loop {
        if supervisor.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        match supervisor.start_once().await {
            Ok(mut close_rx) => {
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
                    event = close_rx.recv() => {
                        let event = event.unwrap_or(RcloneEvent { kind: "close".into(), code: None, intentional: true });
                        *supervisor.target.write().unwrap() = None;
                        supervisor.transfers.daemon_stopped();
                        if event.intentional || supervisor.shutting_down.load(Ordering::SeqCst) {
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
                            supervisor.crashed(&event, attempts).await;
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
