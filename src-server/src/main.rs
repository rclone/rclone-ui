//! `rclone-ui-server`: the shared Rclone UI core behind an HTTP + WebSocket API, serving the
//! same frontend bundle the desktop app embeds. No Tauri, no GTK/WebKit — it runs in a
//! container or on a headless box.

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};
use rclone_ui_server::{serve, AuthMode, Hooks, ServeOpts};
use rclone_ui_shared::lifecycle::Options as LifecycleOptions;

#[derive(Parser, Debug)]
#[command(
    name = "rclone-ui-server",
    version,
    about = "Rclone UI served to a browser"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    #[command(flatten)]
    serve: CliServe,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Start the HTTP server (the default when no subcommand is given).
    Serve(CliServe),
    /// Print every RPC name the server answers.
    ListCommands,
}

#[derive(Args, Debug, Clone)]
struct CliServe {
    /// Address to listen on.
    #[arg(long, env = "RCLONE_UI_BIND", default_value = "127.0.0.1:5573")]
    bind: String,
    /// The owner account's password. Required. It seeds the owner on the first start and is
    /// ignored once accounts exist (Settings › Team; delete state/team.json to start over).
    #[arg(long, env = "RCLONE_UI_PASSWORD")]
    password: Option<String>,
    /// The owner account's email, used with --password on the first start only.
    #[arg(long, env = "RCLONE_UI_EMAIL", default_value = rclone_ui_server::team::DEFAULT_OWNER_EMAIL)]
    email: String,
    /// The data directory: state, accounts, schedules, rclone configs and binaries, logs
    /// (defaults to the desktop app's).
    #[arg(long, env = "RCLONE_UI_DATA_DIR")]
    data_dir: Option<PathBuf>,
    /// rclone binary to run instead of the stored / system / downloaded one.
    #[arg(long, env = "RCLONE_UI_RCLONE_PATH")]
    rclone_path: Option<PathBuf>,
    /// Use an already-running rclone RC daemon at this URL instead of managing one.
    #[arg(long, env = "RCLONE_UI_RCLONE_URL")]
    rclone_url: Option<String>,
    /// Skip the remotes' "mount on start" jobs.
    #[arg(long, env = "RCLONE_UI_NO_AUTOMOUNT")]
    no_automount: bool,
    /// Run the managed daemon with `--log-level INFO`.
    #[arg(long, env = "RCLONE_UI_VERBOSE_RCLONE")]
    verbose_rclone: bool,
    /// Forward non-API requests to a Vite dev server instead of serving the embedded bundle.
    #[arg(long, env = "RCLONE_UI_DEV_PROXY")]
    dev_proxy: Option<String>,
    /// Delete everything in the data directory before starting: accounts, hosts, settings,
    /// schedules, notification targets, rclone configs and downloaded binaries. The owner is
    /// seeded again from --password.
    #[arg(long, env = "RCLONE_UI_CLEAR")]
    clear: bool,
}

fn main() {
    // Headless scheduled-task mode, identical to the desktop binary's: `run-task <taskId>
    // [--host <hostId>] [--data-dir X]`. Handled before any runtime or server state
    // exists so the child behaves exactly like the desktop's runner.
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 3 && args[1] == "run-task" {
        let _ = fix_path_env::fix();
        let flag_value = |flag: &str| {
            args.iter()
                .position(|a| a == flag)
                .and_then(|i| args.get(i + 1))
                .cloned()
        };
        let task_id = args[2].clone();
        let host_id = flag_value("--host").unwrap_or_else(|| "local".to_string());
        let data_dir = flag_value("--data-dir");
        std::process::exit(rclone_ui_shared::scheduler::runner::run(
            &task_id,
            &host_id,
            data_dir.as_deref(),
        ));
    }

    // The metadata mapper (`--metadata-mapper`), which rclone spawns once per file and
    // directory copied: one JSON object in, one out, nothing started, nothing logged.
    if args.len() >= 2 && args[1] == "metadata-map" {
        std::process::exit(rclone_ui_shared::metadata_mapper::run(&args[2..]));
    }

    let _ = fix_path_env::fix();

    let cli = Cli::parse();
    let opts = match cli.command {
        Some(Command::ListCommands) => {
            let mut names: Vec<&str> = rclone_ui_shared::commands::COMMAND_NAMES.to_vec();
            names.extend(rclone_ui_server::server_rpcs::SERVER_RPCS);
            names.sort_unstable();
            for name in names {
                println!("{}", name);
            }
            return;
        }
        Some(Command::Serve(opts)) => opts,
        None => cli.serve,
    };

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to build the tokio runtime");
    if let Err(e) = runtime.block_on(run(opts)) {
        eprintln!("rclone-ui-server: {}", e);
        std::process::exit(1);
    }
}

async fn run(cli: CliServe) -> Result<(), String> {
    let addr: std::net::SocketAddr = cli
        .bind
        .parse()
        .map_err(|e| format!("invalid --bind '{}': {}", cli.bind, e))?;
    let password = cli.password.clone().filter(|p| !p.is_empty()).ok_or_else(|| {
        "a password is required: set --password or RCLONE_UI_PASSWORD (it becomes the owner account's password on the first start)".to_string()
    })?;

    let dirs = match &cli.data_dir {
        Some(d) => rclone_ui_shared::DataDir { root: d.clone() },
        None => rclone_ui_shared::DataDir::from_env()?,
    };
    // Before anything is opened or written (the log file included): a clean slate, then the
    // layout this build reads.
    let cleared = if cli.clear { Some(dirs.clear()?) } else { None };
    let migration = rclone_ui_shared::storage::migrate(
        &dirs.root,
        rclone_ui_shared::storage::Environment::Server,
    )?;
    // An overridden data directory (development, tests, containers) keeps its logs with its
    // data; otherwise the platform's app-log directory, where the desktop's log plugin writes.
    let log_dir = if cli.data_dir.is_some() {
        dirs.root.join("logs")
    } else {
        rclone_ui_server::static_files::log_dir_for(&dirs)
    };
    let log_file = rclone_ui_server::logging::init(&log_dir);
    log::info!("logging to {}", log_file.display());
    if let Some(cleared) = cleared {
        log::warn!(
            "--clear: removed {} entries under {}; starting from scratch",
            cleared,
            dirs.root.display()
        );
    }
    if migration.from != migration.to {
        log::info!(
            "storage migrated from version {} to {}",
            migration.from,
            migration.to
        );
    }
    for note in &migration.notes {
        log::warn!("storage: {}", note);
    }

    // The server is a long-running daemon (possibly in a container with no cron): tasks fire from
    // its own minute loop.
    tokio::spawn(rclone_ui_shared::scheduler::ticker::run_ticker(
        dirs.clone(),
    ));
    log::info!("data dir {}", dirs.root.display());

    // After a relaunch the previous process may still hold the port for a moment.
    let listener =
        rclone_ui_server::port::bind_with_retry(addr, 20, std::time::Duration::from_millis(500))
            .await?;

    let hooks = Hooks::standalone();
    let handle = serve(
        listener,
        ServeOpts {
            auth: AuthMode::Users {
                email: cli.email.clone(),
                password,
            },
            dirs,
            log_dir: Some(log_dir),
            rclone_url: cli.rclone_url.clone(),
            dev_proxy: cli.dev_proxy,
        },
        hooks,
    )
    .await?;

    match &cli.rclone_url {
        Some(url) => log::info!("using the external rclone daemon at {}", url),
        None => {
            let mounts = !cli.no_automount
                && handle.state.capabilities["mount"]
                    .as_bool()
                    .unwrap_or(false);
            handle.start_lifecycle(LifecycleOptions {
                rclone_path_override: cli.rclone_path.clone(),
                mounts,
                verbose: cli.verbose_rclone,
                path_integration: true,
                check_updates: true,
                interaction: handle.state.hooks.interaction.clone(),
            });
        }
    }

    tokio::select! {
        result = handle.wait() => result?,
        _ = shutdown_signal() => {},
    }
    handle.shutdown().await;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    log::info!("shutting down");
}
