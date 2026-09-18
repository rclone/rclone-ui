//! The orchestrator — the only one: it runs rclone for the desktop app and the standalone
//! server alike. Resolve a binary, resolve the active config, spawn `rclone rcd`, wait for it,
//! restart it on request (coalescing bursts, applying the initiating page's overrides first),
//! restart it after a crash with backoff, tell the transfers service when it went down, and run
//! the startup mounts. Where a
//! human decision is needed at boot it asks the host through [`Interaction`].

pub mod config;
pub mod interaction;
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
use interaction::{ask, Decision, Question, SharedInteraction};

pub use interaction::{Interaction, ServerPolicy};

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
    /// The active config is encrypted and no password is stored: the UI has to save one.
    NeedsPassword {
        config_id: String,
        label: String,
    },
    /// `fatal` = the host decided to give up (nothing restarts until asked).
    Failed {
        error: String,
        attempts: u32,
        fatal: bool,
    },
}

impl Phase {
    /// The desktop startup window's vocabulary (`src/pages/Startup.tsx`).
    pub fn startup_status(&self) -> &'static str {
        match self {
            Phase::Stopped | Phase::Resolving | Phase::Starting | Phase::Downloading { .. } => {
                "initializing"
            }
            Phase::Updating { .. } => "updating",
            Phase::Ready { updated: true, .. } => "updated",
            Phase::Ready { .. } => "initialized",
            Phase::NeedsPassword { .. } => "error",
            Phase::Failed { fatal: true, .. } => "fatal",
            Phase::Failed { .. } => "error",
        }
    }
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
    pub default_config_path: Option<String>,
    pub config_files: Option<Value>,
    pub active_config_id: Option<Value>,
    pub proxy: Option<Value>,
    pub sync_config_to_system: Option<bool>,
    pub sync_config_link_target: Option<Value>,
}

pub struct Options {
    /// Use this binary instead of resolving/downloading one.
    pub rclone_path_override: Option<PathBuf>,
    /// Run the remotes' "mount on start" jobs once the daemon is up.
    pub mounts: bool,
    /// `--log-level INFO` on the daemon.
    pub verbose: bool,
    /// Keep the PATH-integration pointer (`<local>/bin/rclone`) aimed at the active binary.
    pub path_integration: bool,
    /// Check downloads.rclone.org for a newer managed binary at boot. Whether a newer one is
    /// installed or only announced is the user's `autoUpdateRclone` setting, read by the check
    /// itself; turning the check off here would silence the announcement too.
    pub check_updates: bool,
    /// Who answers boot-time questions.
    pub interaction: SharedInteraction,
}

enum StartError {
    NeedsPassword { config_id: String, label: String },
    Fatal(String),
    Other(String),
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
        // Same order as the old RESTART_RCLONE handler: configFiles before activeConfigId.
        if let Some(path) = overrides.rclone_path {
            if let Err(e) = self.store.update(APP_DOC, |s| {
                s.insert("rclonePath".into(), Value::String(path));
            }) {
                log::warn!("[lifecycle] could not persist rclonePath: {}", e);
            }
        }
        let host_updates: Vec<(&str, Option<Value>)> = vec![
            (
                "defaultConfigPath",
                overrides.default_config_path.map(Value::String),
            ),
            ("configFiles", overrides.config_files),
            ("activeConfigId", overrides.active_config_id),
            ("proxy", overrides.proxy),
            (
                "syncConfigToSystem",
                overrides.sync_config_to_system.map(Value::Bool),
            ),
            ("syncConfigLinkTarget", overrides.sync_config_link_target),
        ];
        if host_updates.iter().any(|(_, v)| v.is_some()) {
            let result = self.store.update(HOST_DOC, |s| {
                for (key, value) in host_updates {
                    if let Some(value) = value {
                        s.insert(key.to_string(), value);
                    }
                }
            });
            if let Err(e) = result {
                log::warn!("[lifecycle] could not persist restart overrides: {}", e);
            }
        }
    }

    async fn start_once(&self) -> Result<mpsc::UnboundedReceiver<RcloneEvent>, StartError> {
        self.set_phase(Phase::Resolving);
        let path = resolve::resolve_binary(
            &self.ctx,
            &self.store,
            &self.options.interaction,
            self.options.rclone_path_override.as_deref(),
            |version| self.set_phase(Phase::Downloading { version }),
        )
        .await
        .map_err(StartError::Other)?;

        // A managed binary may be auto-updated; either way keep the PATH pointer on it.
        let (path, updated) =
            if self.options.check_updates && self.options.rclone_path_override.is_none() {
                resolve::maybe_auto_update(&self.ctx, &self.store, path, |from, to| {
                    self.set_phase(Phase::Updating { from, to })
                })
                .await
            } else {
                (path, false)
            };
        if self.options.path_integration {
            if let Err(e) = zookeeper::update_path_pointer(&self.ctx, path.clone()) {
                log::warn!("[lifecycle] update_path_pointer failed: {}", e);
            }
        }

        let ctx = self.ctx.clone();
        let store = Arc::clone(&self.store);
        let interaction = Arc::clone(&self.options.interaction);
        let rclone_path = path.clone();
        let resolved = rt::spawn_blocking(move || {
            config::resolve(&ctx, &store, interaction.as_ref(), &rclone_path)
        })
        .await
        .map_err(|e| StartError::Other(e.to_string()))?
        .map_err(|e| match e {
            config::ConfigError::NeedsPassword { config_id, label } => {
                StartError::NeedsPassword { config_id, label }
            }
            config::ConfigError::Other(message) => StartError::Other(message),
        })?;

        // Informational proxy check (the env vars come from build_run_env regardless): one
        // request through the proxy, once per proxy URL. It costs up to 10 s and reaches a third
        // party, so a restart with the same proxy (crash recovery, a settings change) skips it.
        if let Some(proxy) = resolved
            .env
            .get("https_proxy")
            .cloned()
            .filter(|p| !p.is_empty())
        {
            let probed = self.proxy_probed.lock().unwrap().as_deref() == Some(proxy.as_str());
            if !probed {
                if let Err(error) = misc::test_proxy_connection(&self.ctx, proxy.clone()).await {
                    let decision = ask(
                        &self.options.interaction,
                        Question::ProxyUnreachable {
                            url: proxy.clone(),
                            error: error.clone(),
                        },
                    )
                    .await;
                    if decision == Decision::Exit {
                        return Err(StartError::Fatal(format!("proxy unreachable: {}", error)));
                    }
                }
                *self.proxy_probed.lock().unwrap() = Some(proxy);
            }
        }

        self.set_phase(Phase::Starting);
        let port = rc::pick_port().map_err(StartError::Other)?;
        let user = rc::random_token("user");
        let pass = rc::random_token("pass");
        let mut args: Vec<String> = [
            "rcd",
            "--rc-addr",
            &format!("127.0.0.1:{}", port),
            "--rc-user",
            &user,
            "--rc-pass",
            &pass,
            "--rc-serve",
            "--rc-job-expire-duration",
            "24h",
            "--rc-job-expire-interval",
            "1h",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        if self.options.verbose {
            args.extend(["--log-level".to_string(), "INFO".to_string()]);
        }

        let (close_tx, close_rx) = mpsc::unbounded_channel::<RcloneEvent>();
        log::info!("[lifecycle] starting {} on port {}", path, port);
        let pid = zookeeper::spawn_rclone_with(
            &self.ctx,
            path,
            args,
            resolved.env,
            Box::new(move |event| {
                let _ = close_tx.send(event);
            }),
        )
        .map_err(StartError::Other)?;

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
            .map_err(StartError::Other)?;
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

        // Off the critical path: config-sync self-heal and startup mounts.
        {
            let ctx = self.ctx.clone();
            let store = Arc::clone(&self.store);
            tokio::spawn(async move {
                reconcile_config_sync(&ctx, &store).await;
                scheduler_reconcile::reconcile(&ctx).await;
            });
        }
        if self.options.mounts {
            let ctx = self.ctx.clone();
            tokio::spawn(async move { mounts::startup_mounts(&ctx, &client).await });
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
            fatal: false,
        });
    }
}

/// The desktop's `reconcileConfigSync` (lib/rclone/versions.ts): with intent on, re-point a
/// stale system-config symlink or recreate a deleted one; with intent off but an ownership
/// marker still recorded, remove the link we own. A no-op when both are clear.
async fn reconcile_config_sync(ctx: &Ctx, store: &StateStore) {
    // An unreadable host document is not "sync off": leave the link alone and say so.
    let host_state = match store.state_or_error(HOST_DOC) {
        Ok(state) => state,
        Err(e) => {
            log::warn!(
                "[lifecycle] config sync skipped, host state unreadable: {}",
                e
            );
            return;
        }
    };
    let intent = host_state
        .get("syncConfigToSystem")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let marker = host_state
        .get("syncConfigLinkTarget")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if !intent && marker.is_none() {
        return;
    }
    let Ok(host) = storeread::read_host(&ctx.dirs) else {
        return;
    };
    let active_id = host
        .active_config_id
        .clone()
        .unwrap_or_else(|| "default".into());
    let entry = storeread::find_config(&host, &active_id)
        .cloned()
        .unwrap_or_default();
    let app_config_path = match entry.sync.as_deref().filter(|s| !s.is_empty()) {
        Some(sync) => std::path::Path::new(sync).join("rclone.conf"),
        None => storeread::resolve_config_path(&ctx.dirs, &host, &active_id),
    }
    .to_string_lossy()
    .into_owned();
    let ctx2 = ctx.clone();
    let default_path = host.default_config_path.clone();
    let marker2 = marker.clone();
    let app_config_path2 = app_config_path.clone();
    let result = rt::spawn_blocking(move || {
        zookeeper::set_config_sync(&ctx2, intent, app_config_path2, marker2, default_path)
    })
    .await;
    match result {
        Ok(Ok(status)) => {
            let link_target = if status.managed {
                Some(app_config_path)
            } else {
                None
            };
            let backup = status
                .backup_path
                .clone()
                .filter(|_| status.default_backed_up);
            let _ = store.update(HOST_DOC, |s| {
                s.insert("syncConfigToSystem".into(), Value::Bool(intent));
                s.insert(
                    "syncConfigLinkTarget".into(),
                    link_target.map(Value::String).unwrap_or(Value::Null),
                );
                if let Some(backup) = backup {
                    s.insert("defaultConfigPath".into(), Value::String(backup));
                }
            });
        }
        Ok(Err(e)) => log::warn!("[lifecycle] config sync reconcile failed: {}", e),
        Err(e) => log::warn!("[lifecycle] config sync reconcile failed: {}", e),
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
    // seconds later would otherwise restart every two seconds forever, never reaching the host.
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
                            if attempts >= MAX_ATTEMPTS {
                                // Give the host a say: the desktop shows Relaunch/Exit, the
                                // server keeps trying at the longest backoff.
                                let question = Question::RcloneCrashed { code: event.code, attempts };
                                match ask(&supervisor.options.interaction, question).await {
                                    Decision::Relaunch | Decision::Retry | Decision::Yes => {
                                        attempts = 0;
                                        continue;
                                    }
                                    Decision::Exit => {
                                        supervisor.set_phase(Phase::Failed {
                                            error: "rclone kept crashing".into(),
                                            attempts,
                                            fatal: true,
                                        });
                                        if !wait_for_restart(&supervisor, &mut restart_rx, None).await {
                                            return;
                                        }
                                        attempts = 0;
                                    }
                                    _ => {
                                        if !wait_for_restart(&supervisor, &mut restart_rx, Some(backoff(attempts))).await {
                                            return;
                                        }
                                    }
                                }
                            } else if !wait_for_restart(&supervisor, &mut restart_rx, Some(backoff(attempts))).await {
                                return;
                            }
                        }
                    }
                }
            }
            Err(StartError::NeedsPassword { config_id, label }) => {
                supervisor.stop_daemon().await;
                log::warn!(
                    "[lifecycle] config '{}' is encrypted and has no stored password",
                    label
                );
                supervisor.set_phase(Phase::NeedsPassword { config_id, label });
                if !wait_for_restart(&supervisor, &mut restart_rx, None).await {
                    return;
                }
                attempts = 0;
            }
            Err(StartError::Fatal(error)) => {
                supervisor.stop_daemon().await;
                log::error!("[lifecycle] {}", error);
                supervisor.set_phase(Phase::Failed {
                    error,
                    attempts,
                    fatal: true,
                });
                if !wait_for_restart(&supervisor, &mut restart_rx, None).await {
                    return;
                }
                attempts = 0;
            }
            Err(StartError::Other(error)) => {
                supervisor.stop_daemon().await;
                attempts = attempts.saturating_add(1);
                log::error!("[lifecycle] start failed (attempt {}): {}", attempts, error);
                supervisor.set_phase(Phase::Failed {
                    error: error.clone(),
                    attempts,
                    fatal: false,
                });
                if attempts >= MAX_ATTEMPTS {
                    // The desktop parks (its Startup window shows the error, a page restarts);
                    // the server keeps trying at the longest backoff.
                    let question = Question::StartFailed { error, attempts };
                    match ask(&supervisor.options.interaction, question).await {
                        Decision::Relaunch | Decision::Retry | Decision::Yes => {
                            attempts = 0;
                            continue;
                        }
                        Decision::Continue => {
                            if !wait_for_restart(
                                &supervisor,
                                &mut restart_rx,
                                Some(backoff(attempts)),
                            )
                            .await
                            {
                                return;
                            }
                        }
                        Decision::Exit => {
                            supervisor.set_phase(Phase::Failed {
                                error: "rclone could not be started".into(),
                                attempts,
                                fatal: true,
                            });
                            if !wait_for_restart(&supervisor, &mut restart_rx, None).await {
                                return;
                            }
                            attempts = 0;
                        }
                        _ => {
                            if !wait_for_restart(&supervisor, &mut restart_rx, None).await {
                                return;
                            }
                            attempts = 0;
                        }
                    }
                } else if !wait_for_restart(&supervisor, &mut restart_rx, Some(backoff(attempts)))
                    .await
                {
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
