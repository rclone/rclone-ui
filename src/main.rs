//! `rclone-cloud`: rclone behind an HTTP + WebSocket API, with the frontend bundle served to a
//! browser. It runs in a container or on a headless box.

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};
use rclone_cloud::{serve, Owner, ServeOpts};
use rclone_cloud::lifecycle::Options as LifecycleOptions;

#[derive(Parser, Debug)]
#[command(
    name = "rclone-cloud",
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
    #[arg(long, env = "RCLONE_CLOUD_BIND", default_value = "127.0.0.1:5573")]
    bind: String,
    /// The owner account's password. Required. It seeds the owner on the first start and is
    /// ignored once accounts exist (Settings › Team; delete state/team.json to start over).
    #[arg(long, env = "RCLONE_CLOUD_PASSWORD")]
    password: Option<String>,
    /// The owner account's email, used with --password on the first start only.
    #[arg(long, env = "RCLONE_CLOUD_EMAIL", default_value = rclone_cloud::team::DEFAULT_OWNER_EMAIL)]
    email: String,
    /// The data directory: state, accounts, schedules, rclone binaries, logs
    /// (defaults to this machine's local data directory, under com.rclone.cloud).
    #[arg(long, env = "RCLONE_CLOUD_DATA_DIR")]
    data_dir: Option<PathBuf>,
    /// rclone binary to run instead of the stored / system / downloaded one.
    #[arg(long, env = "RCLONE_CLOUD_RCLONE_PATH")]
    rclone_path: Option<PathBuf>,
    /// Use an already-running rclone RC daemon at this URL instead of managing one.
    #[arg(long, env = "RCLONE_CLOUD_RCLONE_URL")]
    rclone_url: Option<String>,
    /// Forward non-API requests to a Vite dev server instead of serving the embedded bundle.
    #[arg(long, env = "RCLONE_CLOUD_DEV_PROXY")]
    dev_proxy: Option<String>,
    /// Delete everything in the data directory before starting: accounts, settings, schedules,
    /// notification targets and downloaded binaries. The owner is seeded again from --password.
    #[arg(long, env = "RCLONE_CLOUD_CLEAR")]
    clear: bool,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // The metadata mapper (`--metadata-mapper`), which rclone spawns once per file and
    // directory copied: one JSON object in, one out, nothing started, nothing logged.
    if args.len() >= 2 && args[1] == "metadata-map" {
        std::process::exit(rclone_cloud::metadata_mapper::run(&args[2..]));
    }

    let _ = fix_path_env::fix();

    let cli = Cli::parse();
    let opts = match cli.command {
        Some(Command::ListCommands) => {
            let mut names: Vec<&str> = rclone_cloud::commands::COMMAND_NAMES.to_vec();
            names.extend(rclone_cloud::server_rpcs::SERVER_RPCS);
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
        eprintln!("rclone-cloud: {}", e);
        std::process::exit(1);
    }
}

async fn run(cli: CliServe) -> Result<(), String> {
    let addr: std::net::SocketAddr = cli
        .bind
        .parse()
        .map_err(|e| format!("invalid --bind '{}': {}", cli.bind, e))?;
    let password = cli.password.clone().filter(|p| !p.is_empty()).ok_or_else(|| {
        "a password is required: set --password or RCLONE_CLOUD_PASSWORD (it becomes the owner account's password on the first start)".to_string()
    })?;

    let dirs = match &cli.data_dir {
        Some(d) => rclone_cloud::DataDir { root: d.clone() },
        None => rclone_cloud::DataDir::from_env()?,
    };
    // Before anything is opened or written (the log file included): a clean slate, then the
    // layout this build reads.
    let cleared = if cli.clear { Some(dirs.clear()?) } else { None };
    let migration = rclone_cloud::storage::migrate(&dirs.root)?;
    let log_dir = dirs.root.join("logs");
    let log_file = rclone_cloud::logging::init(&log_dir);
    log::info!("logging to {}", log_file.display());
    if let Some(cleared) = cleared {
        log::warn!(
            "--clear: removed {} entries under {}; starting from scratch",
            cleared,
            dirs.root.display()
        );
    }
    if migration.from == 0 {
        log::info!("storage at version {}", migration.to);
    } else if migration.from != migration.to {
        log::info!(
            "storage migrated from version {} to {}",
            migration.from,
            migration.to
        );
    }
    for note in &migration.notes {
        log::warn!("storage: {}", note);
    }

    log::info!("data dir {}", dirs.root.display());

    // After a relaunch the previous process may still hold the port for a moment.
    let listener =
        rclone_cloud::port::bind_with_retry(addr, 20, std::time::Duration::from_millis(500))
            .await?;

    let handle = serve(
        listener,
        ServeOpts {
            owner: Owner {
                email: cli.email.clone(),
                password,
            },
            dirs,
            rclone_url: cli.rclone_url.clone(),
            dev_proxy: cli.dev_proxy,
        },
    )
    .await?;

    match &cli.rclone_url {
        Some(url) => log::info!("using the external rclone daemon at {}", url),
        None => {
            let can_mount = handle.state.capabilities["mount"]
                .as_bool()
                .unwrap_or(false);
            handle.start_lifecycle(LifecycleOptions {
                rclone_path_override: cli.rclone_path.clone(),
                can_mount,
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
