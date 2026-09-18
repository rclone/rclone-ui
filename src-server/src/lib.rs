//! rclone-ui-server as a library: one HTTP + WebSocket server that serves the frontend bundle and
//! answers its API, embedded by the desktop app (whose windows load `http://127.0.0.1:<port>/…`)
//! and run standalone by `main.rs` for browser deployments. The host describes what it can do on
//! top of the shared core through [`Hooks`] (native windows, an updater, autostart, OS toasts,
//! boot-time questions, quitting) and gets a [`Handle`] back to start the rclone lifecycle and
//! shut the server down.
//!
//! Routes:
//!
//! | Route | What |
//! |---|---|
//! | `GET /__boot?t=&next=` | token mode: turn the launch token into the session cookie |
//! | `GET /api/status` | mode, version, lifecycle phase, daemon, tunnel |
//! | `POST /api/rpc/{name}` | shared command table + the server's own RPCs |
//! | `POST /api/native/{name}` | the host's [`NativeBridge`] (desktop windows), else 404 |
//! | `GET/PATCH/PUT /api/state/{doc}` | revisioned state documents |
//! | `ANY /api/rc/{host}/{*path}` | streaming reverse proxy to an rclone daemon |
//! | `GET /api/dl/{token}` | short-lived signed download link |
//! | `POST /api/proxy` | allow-listed third-party fetch |
//! | `GET /api/ws` | stream events + bus events |
//! | everything else | `src-frontend/dist/` with the boot script injected into index.html |

pub mod auth;
pub mod autostart;
pub mod download;
pub mod fs;
pub mod logging;
pub mod native;
pub mod port;
pub mod proxy;
pub mod rc_proxy;
pub mod rpc;
pub mod server_rpcs;
pub mod state_api;
pub mod static_files;
pub mod team;
pub mod tunnel;
pub mod updater;
pub mod ws;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use rclone_ui_shared::lifecycle::interaction::SharedInteraction;
use rclone_ui_shared::lifecycle::{Options as LifecycleOptions, Supervisor};
use rclone_ui_shared::rc::RcClient;
use rclone_ui_shared::scheduler::storeread;
use rclone_ui_shared::state_files::{StateStore, APP_DOC};
use rclone_ui_shared::transfers::service::TransferService;
use rclone_ui_shared::{Ctx, DataDir, Events, Sink};
use serde_json::{json, Map, Value};
use tokio::net::TcpListener;
use tokio::sync::watch;

pub use rclone_ui_shared::lifecycle::{Interaction, ServerPolicy};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Embedded in the desktop app: windows are native, the token guards the origin.
    Desktop,
    /// Standalone: browser tabs, optional password.
    Server,
}

impl Mode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Mode::Desktop => "desktop",
            Mode::Server => "server",
        }
    }
}

pub enum AuthMode {
    /// Accounts (`team.rs`): `POST /api/login {email, password}` → session cookie. The pair
    /// seeds the owner account on the first start and is ignored once accounts exist.
    Users { email: String, password: String },
    /// A per-launch token handed to windows through `/__boot` (the embedded server).
    Token,
}

pub struct ServeOpts {
    pub auth: AuthMode,
    pub dirs: DataDir,
    /// Where the host writes its log file; reported to the pages (About, bug reports).
    /// `None` = the platform's app-log directory for the app identifier.
    pub log_dir: Option<std::path::PathBuf>,
    /// Use an already-running RC daemon instead of managing one.
    pub rclone_url: Option<String>,
    /// Forward non-API requests to a Vite dev server.
    pub dev_proxy: Option<String>,
}

/// What the desktop shell exposes to its windows over `POST /api/native/{name}`.
pub trait NativeBridge: Send + Sync {
    /// Runs on the blocking pool; may take a while (opening a window sleeps for its animation).
    fn call(&self, name: &str, args: Value) -> Result<Value, String>;
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub body: Option<String>,
    pub date: Option<String>,
}

/// Self-update of the host binary.
pub trait Updater: Send + Sync {
    /// Blocking. `None` = up to date.
    fn check(&self) -> Result<Option<UpdateInfo>, String>;
    /// Blocking. Streams `{event:'Started'|'Progress'|'Finished', data}` like the Tauri updater.
    fn install(&self, progress: Sink<Value>) -> Result<(), String>;
}

/// Start-at-login of the host binary.
pub trait Autostart: Send + Sync {
    fn is_enabled(&self) -> Result<bool, String>;
    fn set_enabled(&self, enabled: bool) -> Result<(), String>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuitKind {
    Exit,
    Relaunch,
}

pub type OsNotify = Arc<dyn Fn(&str, &str) -> Result<(), String> + Send + Sync>;
pub type OnQuit = Arc<dyn Fn(QuitKind) + Send + Sync>;
pub type OpenExternal = Arc<dyn Fn(&str, &str) -> Result<(), String> + Send + Sync>;

pub struct Hooks {
    pub mode: Mode,
    /// Overrides on top of the computed capabilities (the desktop sets `window`, `tunnel`, …).
    pub capabilities: Map<String, Value>,
    /// Who answers the orchestrator's boot-time questions.
    pub interaction: SharedInteraction,
    pub native: Option<Arc<dyn NativeBridge>>,
    pub updater: Option<Arc<dyn Updater>>,
    pub autostart: Option<Arc<dyn Autostart>>,
    /// `(title, body)` → an OS toast.
    pub os_notify: Option<OsNotify>,
    /// Called last in the quit/relaunch flow, after the daemon and tunnel are down.
    pub on_quit: OnQuit,
}

impl Hooks {
    /// The standalone server's behaviour: never prompts, updates itself from the release
    /// manifest, registers a login item, toasts through notify-rust, exits/relaunches the process.
    pub fn standalone() -> Hooks {
        Hooks {
            mode: Mode::Server,
            capabilities: Map::new(),
            interaction: Arc::new(ServerPolicy),
            native: None,
            updater: Some(Arc::new(updater::SelfUpdater)),
            autostart: Some(Arc::new(autostart::LoginItem)),
            os_notify: Some(Arc::new(|title, body| {
                rclone_ui_shared::notifications::os::notify_headless(title, body)
            })),
            on_quit: Arc::new(|kind| {
                if kind == QuitKind::Relaunch {
                    if supervised() {
                        log::info!(
                            "relaunch requested; leaving the restart to the service manager"
                        );
                        std::process::exit(RESTART_EXIT_CODE);
                    }
                    if let Err(e) = relaunch_process() {
                        log::error!("relaunch failed: {}", e);
                    }
                }
                std::process::exit(0);
            }),
        }
    }
}

/// Exit code that asks a supervisor (systemd `Restart=on-failure`, launchd `SuccessfulExit =
/// false`) to start us again — under one, spawning our own successor is pointless: the
/// supervisor kills the whole process group when the main process exits.
pub const RESTART_EXIT_CODE: i32 = 3;

/// Whether a service manager started this process (the login items `autostart` writes).
pub fn supervised() -> bool {
    std::env::var_os("INVOCATION_ID").is_some()
        || std::env::var("XPC_SERVICE_NAME")
            .map(|name| name.contains("com.rclone.ui.server"))
            .unwrap_or(false)
}

/// The arguments a restart of this process may carry: everything but the one-shot `--clear`,
/// which empties the data directories and must run once, never again on a relaunch or a
/// service-manager start.
pub fn restart_args(args: impl IntoIterator<Item = String>) -> Vec<String> {
    args.into_iter().filter(|a| a != "--clear").collect()
}

/// `RCLONE_UI_CLEAR` is `--clear`'s environment form: as one-shot as the flag.
pub fn is_one_shot_env(key: &str) -> bool {
    key == "RCLONE_UI_CLEAR"
}

/// Starts a fresh copy of this binary with the same arguments (less the one-shot ones); the
/// new process retries the bind until this one has let go of the port (see
/// `port::bind_with_retry`).
pub fn relaunch_process() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let args = restart_args(std::env::args().skip(1));
    std::process::Command::new(exe)
        .args(args)
        .env_remove("RCLONE_UI_CLEAR")
        .stdin(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to start the new process: {}", e))
}

/// Where a host's rclone traffic goes and how to authenticate to it.
#[derive(Clone, Debug)]
pub struct DaemonTarget {
    pub base_url: String,
    pub user: Option<String>,
    pub pass: Option<String>,
}

impl DaemonTarget {
    pub fn client(&self) -> RcClient {
        RcClient::new(self.base_url.clone(), self.user.clone(), self.pass.clone())
    }
}

pub struct AppState {
    pub mode: Mode,
    pub ctx: Ctx,
    pub log_dir: std::path::PathBuf,
    pub store: Arc<StateStore>,
    pub auth: auth::Auth,
    pub team: Arc<team::Team>,
    pub sessions: ws::Sessions,
    pub hooks: Hooks,
    pub capabilities: Value,
    pub external_rclone_url: Option<String>,
    pub dev_proxy: Option<String>,
    /// `None` until the host called [`Handle::start_lifecycle`], or in external-daemon mode.
    pub lifecycle: RwLock<Option<Arc<Supervisor>>>,
    /// Starts, watches and records transfers; alive in every mode, with or without a page.
    pub transfers: Arc<TransferService>,
    pub tunnel: tunnel::Tunnel,
    pub downloads: download::Downloads,
    /// Remotes whose "reconnect?" dialog a page is showing, `host:remote` to when it was
    /// claimed (one dialog app-wide, released when the page is done with it).
    pub reconnect_claims: Mutex<HashMap<String, Instant>>,
    pub http: reqwest::Client,
    pub started_at: Instant,
    quitting: Mutex<bool>,
}

pub type Shared = Arc<AppState>;

impl AppState {
    pub fn supervisor(&self) -> Option<Arc<Supervisor>> {
        self.lifecycle.read().unwrap().clone()
    }

    /// The managed (or external) daemon, when it is reachable.
    pub fn local_daemon(&self) -> Option<DaemonTarget> {
        if let Some(url) = &self.external_rclone_url {
            return Some(DaemonTarget {
                base_url: url.trim_end_matches('/').to_string(),
                user: None,
                pass: None,
            });
        }
        self.supervisor()
            .and_then(|s| s.target())
            .map(|t| DaemonTarget {
                base_url: t.base_url,
                user: Some(t.user),
                pass: Some(t.pass),
            })
    }

    /// The daemon behind a host id: `local` = the managed daemon, anything else a configured
    /// remote host (`hosts[]` in the app state).
    pub fn daemon_for(&self, host_id: &str) -> Option<DaemonTarget> {
        if host_id == "local" {
            return self.local_daemon();
        }
        let state = self.store.state_or_default(APP_DOC);
        let hosts: Vec<storeread::HostEntry> = state
            .get("hosts")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        hosts
            .into_iter()
            .find(|h| h.id == host_id)
            .filter(|h| !h.url.is_empty())
            .map(|h| DaemonTarget {
                base_url: h.url.trim_end_matches('/').to_string(),
                user: h.auth_user.filter(|u| !u.is_empty()),
                pass: h.auth_password,
            })
    }

    pub(crate) fn quitting_flag(&self) -> std::sync::MutexGuard<'_, bool> {
        self.quitting.lock().unwrap()
    }

    /// `true` the first time only; the quit flow runs once.
    pub fn begin_quit(&self) -> bool {
        let mut quitting = self.quitting.lock().unwrap();
        if *quitting {
            return false;
        }
        *quitting = true;
        true
    }

    pub fn status(&self) -> Value {
        let supervisor = self.supervisor();
        let phase = supervisor.as_ref().map(|s| s.phase());
        let app_state = self.store.state_or_default(APP_DOC);
        json!({
            "mode": self.mode.as_str(),
            "version": env!("CARGO_PKG_VERSION"),
            "uptimeSeconds": self.started_at.elapsed().as_secs(),
            "dirs": {
                "data": self.ctx.dirs.root,
            },
            "authRequired": self.auth.required(),
            "managedDaemon": self.external_rclone_url.is_none(),
            "lifecycle": phase.as_ref().map(|p| serde_json::to_value(p).unwrap_or(Value::Null)),
            "startup": phase.as_ref().map(|p| p.startup_status()),
            "daemon": self.local_daemon().map(|d| json!({ "url": d.base_url })),
            "tunnel": self.tunnel.status(),
            "currentHostId": app_state.get("currentHostId").cloned().unwrap_or(Value::Null),
        })
    }
}

pub fn containerized() -> bool {
    if std::path::Path::new("/.dockerenv").exists() {
        return true;
    }
    std::fs::read_to_string("/proc/1/cgroup")
        .map(|c| {
            c.contains("docker")
                || c.contains("containerd")
                || c.contains("kubepods")
                || c.contains("podman")
        })
        .unwrap_or(false)
}

/// Whether the host can mount. WinFsp on Windows is the only prerequisite checked; macOS mounts
/// through the system NFS client and Linux through the distribution's FUSE. Pages re-check at
/// mount time (WinFsp can be installed while the app runs); this decides what the UI offers up
/// front.
pub fn mount_supported() -> bool {
    if cfg!(target_os = "windows") {
        [
            "C:\\Program Files\\WinFsp",
            "C:\\Program Files (x86)\\WinFsp",
        ]
        .iter()
        .any(|p| std::path::Path::new(p).exists())
    } else {
        true
    }
}

/// What this host can do; pages hide UI the host can't back. Same shape on both products.
pub fn capabilities(mode: Mode, overlay: &Map<String, Value>) -> Value {
    let containerized = containerized();
    let mount = mount_supported();
    let desktop = mode == Mode::Desktop;
    let mut caps = json!({
        "mode": mode.as_str(),
        "platform": std::env::consts::OS,
        "containerized": containerized,
        "updater": !containerized,
        "autostart": !containerized,
        "mount": mount,
        "scheduler": true,
        "processExit": !containerized,
        "tunnel": true,
        "deepLink": desktop,
        "configSync": true,
        "pathIntegration": true,
        "window": desktop,
        "osNotifications": !containerized,
    });
    if let Some(map) = caps.as_object_mut() {
        for (key, value) in overlay {
            map.insert(key.clone(), value.clone());
        }
    }
    caps
}

pub struct Handle {
    pub addr: SocketAddr,
    /// The launch token in token mode (`/__boot?t=<token>&next=…`).
    pub token: Option<String>,
    pub state: Shared,
    shutdown: watch::Sender<bool>,
    task: Mutex<Option<tokio::task::JoinHandle<Result<(), String>>>>,
}

impl Handle {
    pub fn origin(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// The URL a window loads: in token mode the boot handshake that sets the cookie and then
    /// redirects to `next`; otherwise `next` itself.
    pub fn boot_url(&self, next: &str) -> String {
        match &self.token {
            Some(token) => format!(
                "{}/__boot?t={}&next={}",
                self.origin(),
                token,
                percent_encoding::utf8_percent_encode(next, percent_encoding::NON_ALPHANUMERIC)
            ),
            None => format!("{}{}", self.origin(), next),
        }
    }

    /// Starts the rclone orchestrator (once). In external-daemon mode this is a no-op.
    pub fn start_lifecycle(&self, options: LifecycleOptions) -> Option<Arc<Supervisor>> {
        if self.state.external_rclone_url.is_some() {
            return None;
        }
        let mut slot = self.state.lifecycle.write().unwrap();
        if let Some(existing) = slot.as_ref() {
            return Some(Arc::clone(existing));
        }
        let supervisor = Supervisor::spawn(
            self.state.ctx.clone(),
            Arc::clone(&self.state.store),
            options,
            Arc::clone(&self.state.transfers),
        );
        *slot = Some(Arc::clone(&supervisor));
        Some(supervisor)
    }

    /// Stops accepting connections, stops the daemon and the tunnel.
    pub async fn shutdown(&self) {
        let _ = self.shutdown.send(true);
        self.state.tunnel.stop().await;
        if let Some(supervisor) = self.state.supervisor() {
            supervisor.shutdown().await;
        }
        let task = self.task.lock().unwrap().take();
        if let Some(task) = task {
            let _ = task.await;
        }
    }

    /// Resolves when the server task ends (graceful shutdown or a fatal error).
    pub async fn wait(&self) -> Result<(), String> {
        let task = self.task.lock().unwrap().take();
        match task {
            Some(task) => task.await.map_err(|e| e.to_string())?,
            None => Ok(()),
        }
    }
}

/// Serves on `listener` (already bound) until [`Handle::shutdown`]. Returns as soon as the
/// server task is running; the lifecycle is started separately by the host.
pub async fn serve(listener: TcpListener, opts: ServeOpts, hooks: Hooks) -> Result<Handle, String> {
    use axum::routing::{any, get, post};
    use axum::Router;

    let addr = listener.local_addr().map_err(|e| e.to_string())?;

    std::fs::create_dir_all(&opts.dirs.root).map_err(|e| e.to_string())?;

    let events = Events::new();
    let ctx = Ctx::new(opts.dirs.clone(), events.clone());
    let store = Arc::new(StateStore::new(opts.dirs.clone(), events));
    let team = Arc::new(team::Team::open(&opts.dirs.root.join("state"))?);
    if let AuthMode::Users { email, password } = &opts.auth {
        if team.seed(email, password)? {
            log::info!("created the owner account {}", email);
        } else {
            log::info!(
                "team: {} account(s), owner {}; --password only seeds the first one",
                team.count(),
                team.owner_email().unwrap_or_default()
            );
        }
    }
    let (auth, token) = auth::Auth::new(opts.auth, team.clone());
    let capabilities = capabilities(hooks.mode, &hooks.capabilities);
    let http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let log_dir = opts
        .log_dir
        .unwrap_or_else(|| static_files::log_dir_for(&opts.dirs));
    // A daemon this process spawns takes its transfers down with it; `--rclone-url` names one
    // that outlives us, like any remote host.
    let transfers = TransferService::new(ctx.clone(), opts.rclone_url.is_none());
    let state: Shared = Arc::new(AppState {
        mode: hooks.mode,
        ctx,
        log_dir,
        store,
        auth,
        team,
        sessions: ws::Sessions::default(),
        capabilities,
        external_rclone_url: opts.rclone_url.map(|u| u.trim_end_matches('/').to_string()),
        dev_proxy: opts.dev_proxy,
        lifecycle: RwLock::new(None),
        transfers,
        tunnel: tunnel::Tunnel::default(),
        downloads: download::Downloads::default(),
        reconnect_claims: Mutex::new(HashMap::new()),
        http,
        started_at: Instant::now(),
        quitting: Mutex::new(false),
        hooks,
    });

    {
        let st = Arc::clone(&state);
        state.transfers.set_host_resolver(Arc::new(move |host| {
            st.daemon_for(host).map(|d| d.client())
        }));
        // Before anything can start a transfer: what the previous process left open is closed
        // or watched again.
        state.transfers.recover();
        state.transfers.spawn_ticker();
    }

    let app = Router::new()
        .route("/__boot", get(auth::boot))
        .route("/api/login", post(auth::login))
        .route("/api/logout", post(auth::logout))
        .route("/api/session", get(auth::session))
        .route("/api/capabilities", get(server_rpcs::capabilities))
        .route("/api/status", get(server_rpcs::status))
        .route(
            "/api/rpc/{name}",
            post(rpc::handle).layer(axum::extract::DefaultBodyLimit::max(1024 * 1024 * 1024)),
        )
        .route("/api/native/{name}", post(native::handle))
        .route(
            "/api/state/{*doc}",
            get(state_api::get)
                .patch(state_api::patch)
                .put(state_api::put),
        )
        .route(
            "/api/rc/{host}/{*path}",
            any(rc_proxy::handle).layer(axum::extract::DefaultBodyLimit::disable()),
        )
        .route("/api/dl/{token}", get(download::handle))
        .route("/api/proxy", post(proxy::handle))
        .route("/api/ws", get(ws::upgrade))
        .fallback(static_files::serve)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::guard,
        ))
        .with_state(state.clone());

    // Rust-side code (the lifecycle's automount) asks for OS toasts over the bus.
    if let Some(os_notify) = state.hooks.os_notify.clone() {
        let mut events = state.ctx.events.subscribe();
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event) if event.name == "os.toast" => {
                        let title = event.payload["title"]
                            .as_str()
                            .unwrap_or("Rclone UI")
                            .to_string();
                        let body = event.payload["body"].as_str().unwrap_or("").to_string();
                        let os_notify = os_notify.clone();
                        rclone_ui_shared::rt::spawn_blocking(move || {
                            if let Err(e) = os_notify(&title, &body) {
                                log::warn!("[toast] {}", e);
                            }
                        });
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    // A managed daemon restart picks a new port and credentials: a pairing tunnel still
    // forwarding to the old ones is rebuilt, and `tunnel.changed` carries the new pairing.
    {
        let state = state.clone();
        let mut events = state.ctx.events.subscribe();
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event)
                        if event.name == "lifecycle.phase" && event.payload["phase"] == "ready" =>
                    {
                        state.tunnel.rebuild_if_stale(&state).await;
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.wait_for(|stop| *stop).await;
            })
            .await
            .map_err(|e| e.to_string())
    });
    log::info!(
        "listening on http://{}{}",
        addr,
        match state.auth.mode() {
            "users" => " (sign-in required)",
            "token" => " (launch token required)",
            _ => "",
        }
    );

    Ok(Handle {
        addr,
        token,
        state,
        shutdown: shutdown_tx,
        task: Mutex::new(Some(task)),
    })
}

#[cfg(test)]
mod restart_tests {
    use super::*;

    /// `--clear` empties the data directories; a relaunch or a login-item start must not do
    /// it again.
    #[test]
    fn a_relaunch_drops_the_one_shot_clear() {
        let args = restart_args(["serve", "--clear", "--password", "x"].map(String::from));
        assert_eq!(args, vec!["serve", "--password", "x"]);
        assert_eq!(restart_args(["serve".to_string()]), vec!["serve"]);
        assert!(is_one_shot_env("RCLONE_UI_CLEAR"));
        assert!(!is_one_shot_env("RCLONE_UI_PASSWORD"));
    }
}
