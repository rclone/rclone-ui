//! The desktop app: Tauri hosts the native pieces (windows, tray, shortcut, deep links, the
//! updater, boot-time dialogs) around the embedded `rclone-ui-server`, which serves every
//! window and runs rclone. See `shell/`.

#[path = "../common/shortcut.rs"]
mod shortcut;

#[path = "../common/window.rs"]
mod window;

#[cfg(target_os = "linux")]
mod jenky;
mod shell;

/// Entry point for the headless `run-task` mode (see main.rs). Never touches tauri::Builder.
pub fn run_scheduled_task(
    task_id: &str,
    host_id: &str,
    forced: bool,
    data_dir: Option<&str>,
) -> i32 {
    rclone_ui_shared::scheduler::runner::run(task_id, host_id, forced, data_dir)
}

/// Entry point for the headless `metadata-map` mode (see main.rs). Never touches tauri::Builder.
pub fn run_metadata_map(args: &[String]) -> i32 {
    rclone_ui_shared::metadata_mapper::run(args)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let client = sentry::init((
        "https://7c7c55918ff850112780d2b2b29121a6@o4508503751983104.ingest.de.sentry.io/4508739164110928",
        sentry::ClientOptions {
            release: sentry::release_name!(),
            ..Default::default()
        },
    ));

    let _guard = tauri_plugin_sentry::minidump::init(&client);

    let mut builder = tauri::Builder::default();

    if !rclone_ui_shared::is_flatpak() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = shortcut::show_toolbar_window(app);
        }));
    }

    #[cfg(target_os = "linux")]
    {
        builder = builder.plugin(jenky::init());
    }

    #[allow(unused_mut)]
    let mut app = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_sentry::init_with_no_injection(&client))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            // The embedded server's HTTP stack is chatty at trace level; the pages' forwarded
            // console (target "webview") keeps its full detail. The file starts over at 10 MB
            // with nothing kept aside (the plugin's default is 40 KB); the standalone server's
            // own logger (`rclone_ui_server::logging`) does the same.
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("webview", log::LevelFilter::Trace)
                .level_for("app_lib", log::LevelFilter::Debug)
                .level_for("rclone_ui_server", log::LevelFilter::Debug)
                .level_for("rclone_ui_shared", log::LevelFilter::Debug)
                .max_file_size(rclone_ui_server::logging::MAX_BYTES as u128)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
        .plugin(tauri_plugin_prevent_default::debug())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(shell::boot::setup)
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    app.run(shell::boot::on_run_event)
}
