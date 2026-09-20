//! rclone-cloud as a library: one HTTP + WebSocket server that serves the frontend bundle to a
//! browser and answers its API. `main.rs` binds the listener, calls [`serve`] and gets a
//! [`Handle`] back to start the rclone lifecycle and shut the server down.
//!
//! Routes:
//!
//! | Route | What |
//! |---|---|
//! | `GET /api/status` | version, lifecycle phase, daemon |
//! | `POST /api/rpc/{name}` | every RPC (`rpc.rs`) |
//! | `GET/PATCH/PUT /api/state/{doc}` | revisioned state documents |
//! | `ANY /api/rc/{*path}` | streaming reverse proxy to the rclone daemon |
//! | `GET /api/dl/{token}` | short-lived signed download link |
//! | `GET /api/ws` | the bus, event by event |
//! | everything else | `frontend/dist/` with the boot script injected into index.html |

pub mod auth;
pub mod bus;
pub mod datadir;
pub mod download;
pub mod fsutil;
pub mod http;
pub mod lifecycle;
pub mod logging;
pub mod metadata_mapper;
pub mod notifications;
pub mod platform;
pub mod port;
pub mod rc;
pub mod rc_proxy;
pub mod resolve_link;
pub mod rpc;
pub mod scheduler;
pub mod state_api;
pub mod state_files;
pub mod static_files;
pub mod storage;
pub mod team;
pub mod time;
pub mod transfers;
pub mod updater;
pub mod version;
pub mod ws;
pub mod zookeeper;

pub use bus::{Bus, Event};
pub use datadir::DataDir;
pub use platform::kill_pid;
pub use state_files::StateStore;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use crate::lifecycle::{Options as LifecycleOptions, Supervisor};
use crate::rc::RcClient;
use crate::transfers::service::TransferService;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::watch;

/// The owner account seeded on the first start.
pub struct Owner {
    pub email: String,
    pub password: String,
}

pub struct ServeOpts {
    /// Accounts (`team.rs`): `POST /api/login {email, password}` → session cookie. The pair
    /// seeds the owner account on the first start and is ignored once accounts exist.
    pub owner: Owner,
    pub dirs: DataDir,
    /// Use an already-running RC daemon instead of managing one.
    pub rclone_url: Option<String>,
    /// Forward non-API requests to a Vite dev server.
    pub dev_proxy: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuitKind {
    Exit,
    Relaunch,
}

/// The last step of the quit/relaunch flow, after the daemon is down.
pub fn exit(kind: QuitKind) -> ! {
    if kind == QuitKind::Relaunch {
        if supervised() {
            log::info!("relaunch requested; leaving the restart to the service manager");
            std::process::exit(RESTART_EXIT_CODE);
        }
        if let Err(e) = relaunch_process() {
            log::error!("relaunch failed: {}", e);
        }
    }
    std::process::exit(0);
}

/// Exit code that asks a supervisor (systemd `Restart=on-failure`, launchd `SuccessfulExit =
/// false`) to start us again — under one, spawning our own successor is pointless: the
/// supervisor kills the whole process group when the main process exits.
pub const RESTART_EXIT_CODE: i32 = 3;

/// Whether a service manager started this process: systemd sets `INVOCATION_ID`, and launchd
/// sets `XPC_SERVICE_NAME` to the job's label (a process started from a shell gets the literal
/// `0`). The label itself is not ours to predict — the operator writes the unit or the plist, so
/// matching one particular name would only recognise a service manager we set up ourselves.
pub fn supervised() -> bool {
    std::env::var_os("INVOCATION_ID").is_some()
        || std::env::var("XPC_SERVICE_NAME")
            .map(|name| !name.is_empty() && name != "0")
            .unwrap_or(false)
}

/// The arguments a restart of this process may carry: everything but the one-shot `--clear`,
/// which empties the data directories and must run once, never again on a relaunch or a
/// service-manager start.
pub fn restart_args(args: impl IntoIterator<Item = String>) -> Vec<String> {
    args.into_iter().filter(|a| a != "--clear").collect()
}

/// `RCLONE_CLOUD_CLEAR` is `--clear`'s environment form: as one-shot as the flag.
pub fn is_one_shot_env(key: &str) -> bool {
    key == "RCLONE_CLOUD_CLEAR"
}

/// Starts a fresh copy of this binary with the same arguments (less the one-shot ones); the
/// new process retries the bind until this one has let go of the port (see
/// `port::bind_with_retry`).
pub fn relaunch_process() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let args = restart_args(std::env::args().skip(1));
    std::process::Command::new(exe)
        .args(args)
        .env_remove("RCLONE_CLOUD_CLEAR")
        .stdin(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to start the new process: {}", e))
}

/// Where the rclone traffic goes and how to authenticate to it.
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
    pub dirs: DataDir,
    /// The in-process broadcast bus: every event a page may hear, and the WebSocket's only feed.
    pub bus: Bus,
    pub store: Arc<StateStore>,
    pub auth: auth::Auth,
    pub team: Arc<team::Team>,
    pub capabilities: Value,
    pub external_rclone_url: Option<String>,
    pub dev_proxy: Option<String>,
    /// `None` until [`Handle::start_lifecycle`], or in external-daemon mode.
    pub lifecycle: RwLock<Option<Arc<Supervisor>>>,
    /// Starts, watches and records transfers; alive in every mode, with or without a page.
    pub transfers: Arc<TransferService>,
    pub downloads: download::Downloads,
    /// Remotes whose "reconnect?" dialog a page is showing, each to when it was
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
        json!({
            "version": env!("CARGO_PKG_VERSION"),
            "uptimeSeconds": self.started_at.elapsed().as_secs(),
            "dirs": {
                "data": self.dirs.root,
            },
            "managedDaemon": self.external_rclone_url.is_none(),
            "lifecycle": phase.as_ref().map(|p| serde_json::to_value(p).unwrap_or(Value::Null)),
            "daemon": self.local_daemon().map(|d| json!({ "url": d.base_url })),
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

/// What this machine can do; pages hide UI it can't back.
pub fn capabilities() -> Value {
    let containerized = containerized();
    json!({
        "platform": std::env::consts::OS,
        "containerized": containerized,
        "updater": !containerized,
        "processExit": !containerized,
    })
}

pub struct Handle {
    pub addr: SocketAddr,
    pub state: Shared,
    shutdown: watch::Sender<bool>,
    task: Mutex<Option<tokio::task::JoinHandle<Result<(), String>>>>,
}

impl Handle {
    pub fn origin(&self) -> String {
        format!("http://{}", self.addr)
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
            self.state.dirs.clone(),
            self.state.bus.clone(),
            Arc::clone(&self.state.store),
            options,
            Arc::clone(&self.state.transfers),
        );
        *slot = Some(Arc::clone(&supervisor));
        Some(supervisor)
    }

    /// Stops accepting connections and stops the daemon.
    pub async fn shutdown(&self) {
        let _ = self.shutdown.send(true);
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
/// server task is running; the lifecycle is started separately ([`Handle::start_lifecycle`]).
pub async fn serve(listener: TcpListener, opts: ServeOpts) -> Result<Handle, String> {
    use axum::routing::{any, get, post};
    use axum::Router;

    let addr = listener.local_addr().map_err(|e| e.to_string())?;

    std::fs::create_dir_all(&opts.dirs.root).map_err(|e| e.to_string())?;

    let bus = Bus::new();
    let store = Arc::new(StateStore::new(opts.dirs.clone(), bus.clone()));
    let team = Arc::new(team::Team::open(&opts.dirs.root.join("state"))?);
    if team.seed(&opts.owner.email, &opts.owner.password)? {
        log::info!("created the owner account {}", opts.owner.email);
    } else {
        log::info!(
            "team: {} account(s), owner {}; --password only seeds the first one",
            team.count(),
            team.owner_email().unwrap_or_default()
        );
    }
    let auth = auth::Auth::new(team.clone());
    let capabilities = capabilities();
    let http = http::plain();

    // A daemon this process spawns takes its transfers down with it; `--rclone-url` names one
    // that outlives us.
    let transfers = TransferService::new(opts.dirs.clone(), bus.clone(), opts.rclone_url.is_none());
    let state: Shared = Arc::new(AppState {
        dirs: opts.dirs,
        bus,
        store,
        auth,
        team,
        capabilities,
        external_rclone_url: opts.rclone_url.map(|u| u.trim_end_matches('/').to_string()),
        dev_proxy: opts.dev_proxy,
        lifecycle: RwLock::new(None),
        transfers,
        downloads: download::Downloads::default(),
        reconnect_claims: Mutex::new(HashMap::new()),
        http,
        started_at: Instant::now(),
        quitting: Mutex::new(false),
    });

    {
        let st = Arc::clone(&state);
        state
            .transfers
            .set_daemon_resolver(Arc::new(move || st.local_daemon().map(|d| d.client())));
        // Before anything can start a transfer: what the previous process left open is closed
        // or watched again.
        state.transfers.recover();
        state.transfers.spawn_ticker();
        // The server is a long-running daemon (possibly in a container with no cron), so
        // schedules fire from its own minute loop — and run on it, through the same transfer
        // service as everything else.
        tokio::spawn(scheduler::ticker::run_ticker(
            state.dirs.clone(),
            Arc::clone(&state.transfers),
        ));
    }

    let app = Router::new()
        .route("/api/login", post(auth::login))
        .route("/api/logout", post(auth::logout))
        .route("/api/session", get(auth::session))
        .route("/api/status", get(rpc::status))
        .route(
            "/api/rpc/{name}",
            post(rpc::handle).layer(axum::extract::DefaultBodyLimit::max(1024 * 1024 * 1024)),
        )
        .route(
            "/api/state/{*doc}",
            get(state_api::get)
                .patch(state_api::patch)
                .put(state_api::put),
        )
        .route(
            "/api/rc/{*path}",
            any(rc_proxy::handle).layer(axum::extract::DefaultBodyLimit::disable()),
        )
        .route("/api/dl/{token}", get(download::handle))
        .route("/api/ws", get(ws::upgrade))
        .fallback(static_files::serve)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::guard,
        ))
        .with_state(state.clone());

    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.wait_for(|stop| *stop).await;
            })
            .await
            .map_err(|e| e.to_string())
    });
    log::info!("listening on http://{} (sign-in required)", addr);

    Ok(Handle {
        addr,
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
        assert!(is_one_shot_env("RCLONE_CLOUD_CLEAR"));
        assert!(!is_one_shot_env("RCLONE_CLOUD_PASSWORD"));
    }
}
