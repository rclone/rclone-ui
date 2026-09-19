//! The orchestrator: resolve a binary, spawn `rclone rcd`, wait for it, restart it on request
//! (coalescing bursts, applying the initiating page's overrides first), restart it after a crash
//! with backoff, tell the transfers service when it went down, and run the startup mounts.
//!
//! Nothing here resolves a configuration file. The daemon inherits this process's environment,
//! so `RCLONE_CONFIG`, `XDG_CONFIG_HOME` and `RCLONE_CONFIG_PASS` reach rclone exactly as the
//! operator set them, and rclone picks its own config.

pub mod mounts;
pub mod resolve;
pub mod scheduler_reconcile;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};

use crate::commands::misc;
use crate::ctx::Ctx;
use crate::notifications::webhooks;
use crate::rc::{self, RcClient};
use crate::rt;
use crate::scheduler::storeread;
use crate::state_files::{StateStore, APP_DOC, HOST_DOC};
use crate::transfers::service::TransferService;
use crate::zookeeper::{self, RcloneEvent};

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
    /// A managed rclone is being auto-updated.
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

/// Mirrors the frontend's `RestartRclonePayload`: values the initiating page wants persisted
/// before the daemon comes back.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RestartOverrides {
    pub rclone_path: Option<String>,
    pub proxy: Option<Value>,
}

pub struct Options {
    /// Use this binary instead of resolving/downloading one.
    pub rclone_path_override: Option<PathBuf>,
    /// Whether this host can mount at all ([`crate::mount_supported`]). When it cannot, the
    /// remotes' "mount on start" jobs are not attempted and the reason is logged once.
    pub can_mount: bool,
}

pub struct Supervisor {
    ctx: Ctx,
    store: Arc<StateStore>,
    options: Options,
    phase: watch::Sender<Phase>,
    target: RwLock<Option<RcTarget>>,
    restart_tx: mpsc::UnboundedSender<Option<RestartOverrides>>,
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
        ctx: Ctx,
        store: Arc<StateStore>,
        options: Options,
        transfers: Arc<TransferService>,
    ) -> Arc<Supervisor> {
        let (phase, _) = watch::channel(Phase::Stopped);
        let (restart_tx, restart_rx) = mpsc::unbounded_channel();
        let supervisor = Arc::new(Supervisor {
            ctx,
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

    pub fn subscribe(&self) -> watch::Receiver<Phase> {
        self.phase.subscribe()
    }

    pub fn target(&self) -> Option<RcTarget> {
        self.target.read().unwrap().clone()
    }

    pub fn request_restart(&self, overrides: Option<RestartOverrides>) {
        let _ = self.restart_tx.send(overrides);
    }

    /// Stops the daemon for good (process exit). The loop sees the intentional close and parks.
    pub async fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.stop_daemon().await;
        self.set_phase(Phase::Stopped);
    }

    /// Stops the daemon but keeps the loop alive: it comes back on the next restart request.
    pub async fn stop(&self) {
        self.stop_daemon().await;
    }

    fn set_phase(&self, phase: Phase) {
        self.ctx.events.emit("lifecycle.phase", &phase);
        self.phase.send_replace(phase);
    }

    async fn stop_daemon(&self) {
        *self.target.write().unwrap() = None;
        self.transfers.daemon_stopped();
        let ctx = self.ctx.clone();
        match rt::spawn_blocking(move || zookeeper::kill_rclone_daemon(&ctx, Some(5000))).await {
            Ok(Err(e)) => log::warn!("[lifecycle] failed to stop the daemon: {}", e),
            Err(e) => log::warn!("[lifecycle] failed to stop the daemon: {}", e),
            Ok(Ok(_)) => {}
        }
    }

    fn apply_overrides(&self, overrides: RestartOverrides) {
        if let Some(path) = overrides.rclone_path {
            if let Err(e) = self.store.update(APP_DOC, |s| {
                s.insert("rclonePath".into(), Value::String(path));
            }) {
                log::warn!("[lifecycle] could not persist rclonePath: {}", e);
            }
        }
        if let Some(proxy) = overrides.proxy {
            if let Err(e) = self.store.update(HOST_DOC, |s| {
                s.insert("proxy".into(), proxy);
            }) {
                log::warn!("[lifecycle] could not persist restart overrides: {}", e);
            }
        }
    }

    async fn start_once(&self) -> Result<mpsc::UnboundedReceiver<RcloneEvent>, String> {
        self.set_phase(Phase::Resolving);
        let path = resolve::resolve_binary(
            &self.ctx,
            &self.store,
            self.options.rclone_path_override.as_deref(),
            |version| self.set_phase(Phase::Downloading { version }),
        )
        .await
        ?;

        // A managed binary may be auto-updated; either way keep the PATH pointer on it.
        let (path, updated) =
            if self.options.rclone_path_override.is_none() {
                resolve::maybe_auto_update(&self.ctx, &self.store, path, |from, to| {
                    self.set_phase(Phase::Updating { from, to })
                })
                .await
            } else {
                (path, false)
            };
        if let Err(e) = zookeeper::update_path_pointer(&self.ctx, path.clone()) {
            log::warn!("[lifecycle] update_path_pointer failed: {}", e);
        }

        // The only thing the daemon is told about its environment is the proxy. Its config file
        // is rclone's business: whatever `RCLONE_CONFIG`/`XDG_CONFIG_HOME` this process was given
        // is inherited untouched, and rclone resolves the rest.
        let host = if storeread::host_state_exists(&self.ctx.dirs) {
            storeread::read_host(&self.ctx.dirs)?
        } else {
            storeread::HostState::default()
        };
        let mut env = storeread::build_run_env(&host);

        // Informational proxy check (the env vars come from build_run_env regardless): one
        // request through the proxy, once per proxy URL. It costs up to 10 s and reaches a third
        // party, so a restart with the same proxy (crash recovery, a settings change) skips it.
        if let Some(proxy) = env.get("https_proxy").cloned().filter(|p| !p.is_empty()) {
            let probed = self.proxy_probed.lock().unwrap().as_deref() == Some(proxy.as_str());
            if !probed {
                if let Err(error) = misc::test_proxy_connection(&self.ctx, proxy.clone()).await {
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
            &self.ctx,
            path,
            args,
            env,
            Box::new(move |event| {
                let _ = close_tx.send(event);
            }),
        )
        ?;

        let target = RcTarget {
            base_url: format!("http://127.0.0.1:{}", port),
            user,
            pass,
        };
        let client = target.client();
        let daemon = Arc::clone(&self.ctx.daemon);
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
            let ctx = self.ctx.clone();
            tokio::spawn(async move {
                scheduler_reconcile::reconcile(&ctx).await;
            });
        }
        {
            let ctx = self.ctx.clone();
            let can_mount = self.options.can_mount;
            // A mount pass belongs to the daemon that was up when it started: a crash-looping
            // one would otherwise stack passes, each retrying against a port that is gone.
            let previous = self
                .mounting
                .lock()
                .unwrap()
                .replace(tokio::spawn(async move {
                    mounts::startup_mounts(&ctx, &client, can_mount).await
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
                &self.ctx,
                "rclone.crashed",
                "Rclone daemon crashed",
                &body,
                json!({ "exitCode": event.code }),
            );
        } else if attempts == MAX_ATTEMPTS {
            notify(
                &self.ctx,
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

/// Everything queued behind the request that woke us, merged in arrival order.
fn drain(
    first: Option<RestartOverrides>,
    rx: &mut mpsc::UnboundedReceiver<Option<RestartOverrides>>,
) -> Vec<RestartOverrides> {
    let mut all: Vec<RestartOverrides> = first.into_iter().collect();
    while let Ok(next) = rx.try_recv() {
        all.extend(next);
    }
    all
}

/// Parks until a restart is requested (or the backoff passes when `timeout` is given).
/// Returns `false` when the supervisor is gone.
async fn wait_for_restart(
    supervisor: &Supervisor,
    rx: &mut mpsc::UnboundedReceiver<Option<RestartOverrides>>,
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
        Some(request) => {
            for overrides in drain(request, rx) {
                supervisor.apply_overrides(overrides);
            }
            true
        }
        None => false,
    }
}

async fn run_loop(
    supervisor: Arc<Supervisor>,
    mut restart_rx: mpsc::UnboundedReceiver<Option<RestartOverrides>>,
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
                        let Some(request) = request else { return };
                        log::info!("[lifecycle] restart requested");
                        if started_at.elapsed() >= CRASH_GRACE {
                            attempts = 0;
                        }
                        supervisor.stop_daemon().await;
                        for overrides in drain(request, &mut restart_rx) {
                            supervisor.apply_overrides(overrides);
                        }
                    }
                    event = close_rx.recv() => {
                        let event = event.unwrap_or(RcloneEvent { kind: "close".into(), code: None, intentional: true });
                        *supervisor.target.write().unwrap() = None;
                        supervisor.transfers.daemon_stopped();
                        if event.intentional || supervisor.shutting_down.load(Ordering::SeqCst) {
                            // Stopped on purpose: stay down until something asks for a daemon again.
                            supervisor.set_phase(Phase::Stopped);
                            attempts = 0;
                            if !wait_for_restart(&supervisor, &mut restart_rx, None).await {
                                return;
                            }
                        } else {
                            if started_at.elapsed() >= CRASH_GRACE {
                                attempts = 0;
                            }
                            attempts = attempts.saturating_add(1);
                            supervisor.crashed(&event, attempts).await;
                            if !wait_for_restart(&supervisor, &mut restart_rx, Some(backoff(attempts))).await {
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
                if !wait_for_restart(&supervisor, &mut restart_rx, Some(backoff(attempts))).await {
                    return;
                }
            }
        }
    }
}

/// Fire-and-forget webhook dispatch (delivery outcomes are recorded per target and logged).
pub fn notify(
    ctx: &Ctx,
    event_id: &str,
    title: &str,
    body: &str,
    data: Value,
) -> tokio::task::JoinHandle<()> {
    let dirs = ctx.dirs.clone();
    let event_id = event_id.to_string();
    let title = title.to_string();
    let body = body.to_string();
    // Each on its own: one endpoint that does not answer holds up nothing else. The handle is
    // for the rare caller that must not say two things out of order.
    rt::spawn_blocking(move || {
        let client = webhooks::http_client();
        for line in webhooks::dispatch(&dirs, &client, &event_id, &title, &body, data) {
            log::warn!("[notifications] {}", line);
        }
    })
}
