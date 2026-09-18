//! Process boot (main.ts's chain, now in Rust): Flatpak gate → embedded server → toolbar window,
//! shortcut, tray, deep links → updater policy → the rclone lifecycle → the startup window.

use std::sync::Arc;

use rclone_ui_server::{port, serve, AuthMode, Hooks, Mode, QuitKind, ServeOpts};
use rclone_ui_shared::lifecycle::Options as LifecycleOptions;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;

use super::{
    deeplink, interaction::DesktopInteraction, native_bridge, startup, tray, updater, SharedShell,
    Shell,
};
use crate::shortcut::{ensure_toolbar_window, set_toolbar_shortcut, DEFAULT_TOOLBAR_SHORTCUT};

struct TauriAutostart {
    app: AppHandle,
}

impl rclone_ui_server::Autostart for TauriAutostart {
    fn is_enabled(&self) -> Result<bool, String> {
        self.app
            .autolaunch()
            .is_enabled()
            .map_err(|e| e.to_string())
    }

    fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        if enabled {
            self.app.autolaunch().enable().map_err(|e| e.to_string())
        } else {
            self.app.autolaunch().disable().map_err(|e| e.to_string())
        }
    }
}

/// main.ts `checkFlatpakPermissions`: without host access nothing works, so explain and leave.
fn flatpak_gate(app: &AppHandle) -> bool {
    if !rclone_ui_shared::is_flatpak() || rclone_ui_shared::platform::has_flatpak_permissions() {
        return true;
    }
    let command = "flatpak override --user --filesystem=host --talk-name=org.freedesktop.Flatpak com.rcloneui.RcloneUI";
    let copy = app
        .dialog()
        .message(format!(
            "You are running the flatpak version of Rclone UI, which is sandboxed.\n\nRclone UI needs disk access to manage your files, and host access to schedule tasks. Please grant both using the following command (copy paste in your terminal):\n\n{}\n\nRestart Rclone UI afterwards.",
            command
        ))
        .title("Flatpak Permissions Required")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Copy Command & Exit".into(), "Exit".into()))
        .blocking_show();
    if copy {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        let _ = app.clipboard().write_text(command);
    }
    false
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();

    #[cfg(target_os = "linux")]
    {
        // The quirk decided before the log plugin was live; restate it into the log file.
        log::info!("jenky: {}", crate::jenky::summary());

        // Flatpak/Flathub sandbox typically cannot write to system desktop/mime locations.
        // Deep-link registration is best-effort; never fail app startup.
        if rclone_ui_shared::is_flatpak() {
            log::info!("skipping deep-link registration in Flatpak/Flathub");
        } else {
            use tauri_plugin_deep_link::DeepLinkExt;
            if let Err(err) = app.deep_link().register_all() {
                log::warn!("deep-link registration failed (continuing): {}", err);
            }
        }

        let cache_dir = app.path().cache_dir()?;
        let app_cache = cache_dir.join(app.package_info().name.as_str());
        if app_cache.exists() {
            let _ = std::fs::remove_dir_all(&app_cache);
        }
    }

    #[cfg(windows)]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        if let Err(err) = app.deep_link().register_all() {
            log::warn!("deep-link registration failed (continuing): {}", err);
        }
    }

    if !flatpak_gate(&handle) {
        handle.exit(0);
        return Ok(());
    }

    // The data directory, resolved through Tauri (the platform's local data directory plus
    // the identifier, the same `DataDir::resolve` derives headless); `RCLONE_UI_DATA_DIR`
    // overrides it (development, tests).
    let mut dirs = rclone_ui_shared::DataDir {
        root: app.path().app_local_data_dir()?,
    };
    if let Some(dir) = std::env::var_os("RCLONE_UI_DATA_DIR").filter(|v| !v.is_empty()) {
        dirs.root = dir.into();
    }
    // The layout this build reads, before anything is opened or created under it.
    match rclone_ui_shared::storage::migrate(
        &dirs.root,
        rclone_ui_shared::storage::Environment::Desktop,
    ) {
        Ok(report) => {
            if report.from != report.to {
                log::info!(
                    "storage migrated from version {} to {}",
                    report.from,
                    report.to
                );
            }
            for note in &report.notes {
                log::warn!("storage: {}", note);
            }
        }
        Err(e) => {
            handle
                .dialog()
                .message(format!(
                    "Rclone UI cannot bring its data directory up to date and will not start.\n\n{}",
                    e
                ))
                .title("Data Directory")
                .kind(MessageDialogKind::Error)
                .blocking_show();
            handle.exit(1);
            return Ok(());
        }
    }
    // Reclaim leftover .tmp-* download staging dirs from an interrupted download. Runs once
    // here (before any window) so it can never race a live download.
    rclone_ui_shared::zookeeper::sweep_versions_tmp(&dirs);

    // The embedded server: loopback, a stable port per data dir, a per-launch token.
    let listener = tauri::async_runtime::block_on(port::bind_for(&dirs.root))?;
    // Only `tauri dev` has a Vite dev server to forward to: `is_dev()` is off for every
    // `tauri build`, including `--debug`, so those ship the embedded bundle.
    let dev_proxy = if tauri::is_dev() {
        Some("http://localhost:1420".to_string())
    } else {
        None
    };

    // The hooks need the shell, the shell needs the server handle: build the hooks with a
    // late-bound shell slot.
    let shell_slot: Arc<std::sync::OnceLock<SharedShell>> = Arc::new(std::sync::OnceLock::new());
    let native_slot = Arc::clone(&shell_slot);
    let quit_app = handle.clone();
    let quit_slot = Arc::clone(&shell_slot);
    let notify_app = handle.clone();
    let mut overlay = serde_json::Map::new();
    for key in [
        "window",
        "tunnel",
        "deepLink",
        "configSync",
        "pathIntegration",
        "osNotifications",
        "autostart",
    ] {
        overlay.insert(key.into(), Value::Bool(true));
    }
    overlay.insert(
        "updater".into(),
        Value::Bool(!rclone_ui_shared::is_flatpak()),
    );
    let hooks = Hooks {
        mode: Mode::Desktop,
        capabilities: overlay,
        interaction: Arc::new(DesktopInteraction {
            app: handle.clone(),
        }),
        native: Some(Arc::new(LateBridge { slot: native_slot })),
        updater: Some(Arc::new(updater::TauriUpdater::new(handle.clone()))),
        autostart: Some(Arc::new(TauriAutostart {
            app: handle.clone(),
        })),
        os_notify: Some(Arc::new(move |title, body| {
            notify_app
                .notification()
                .builder()
                .title(title)
                .body(body)
                .show()
                .map_err(|e| e.to_string())
        })),
        on_quit: Arc::new(move |kind| {
            if let Some(shell) = quit_slot.get() {
                shell.mark_quitting();
            }
            match kind {
                QuitKind::Relaunch => quit_app.restart(),
                QuitKind::Exit => quit_app.exit(0),
            }
        }),
    };

    let server = tauri::async_runtime::block_on(serve(
        listener,
        ServeOpts {
            auth: AuthMode::Token,
            dirs,
            // Where tauri-plugin-log's LogDir target writes.
            log_dir: app.path().app_log_dir().ok(),
            rclone_url: None,
            dev_proxy,
        },
        hooks,
    ))?;
    log::info!("embedded server on {}", server.origin());

    let shell = Shell::new(handle.clone(), server);
    let _ = shell_slot.set(Arc::clone(&shell));
    app.manage(Arc::clone(&shell));

    // Crash reporting for what the hidden window used to capture: failed daemon starts.
    {
        let mut events = shell.state().ctx.events.subscribe();
        tauri::async_runtime::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event)
                        if event.name == "lifecycle.phase"
                            && event.payload["phase"] == "failed" =>
                    {
                        let error = event.payload["error"]
                            .as_str()
                            .unwrap_or("rclone failed")
                            .to_string();
                        sentry::capture_message(
                            &format!("rclone lifecycle failed: {}", error),
                            sentry::Level::Error,
                        );
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    if let Err(err) = ensure_toolbar_window(&handle) {
        log::warn!("failed to prepare toolbar window: {}", err);
    }
    if let Err(err) = set_toolbar_shortcut(&handle, Some(DEFAULT_TOOLBAR_SHORTCUT)) {
        log::error!("failed to update default toolbar shortcut: {}", err);
    }
    if let Err(err) = tray::init(&shell) {
        log::error!("failed to create the tray: {}", err);
    }
    deeplink::init(&shell);

    // The rest of the boot chain runs in the background: the updater policy (before any daemon
    // exists), the lifecycle, then the startup window.
    let boot_shell = Arc::clone(&shell);
    tauri::async_runtime::spawn(async move {
        updater::check_at_boot(&boot_shell).await;
        if boot_shell.is_quitting() {
            return;
        }
        // The check runs on every boot; the `autoUpdateRclone` setting decides, inside it,
        // between installing the newer rclone and only announcing it.
        boot_shell.server.start_lifecycle(LifecycleOptions {
            rclone_path_override: None,
            mounts: true,
            verbose: false,
            path_integration: true,
            check_updates: true,
            interaction: boot_shell.state().hooks.interaction.clone(),
        });
        boot_shell.mark_lifecycle_started();
        deeplink::flush(&boot_shell);
        startup::drive(boot_shell).await;
    });

    Ok(())
}

/// The native bridge is created before the shell exists; it resolves it on first use.
struct LateBridge {
    slot: Arc<std::sync::OnceLock<SharedShell>>,
}

impl rclone_ui_server::NativeBridge for LateBridge {
    fn call(&self, name: &str, args: Value) -> Result<Value, String> {
        let shell = self.slot.get().ok_or("the shell is still booting")?;
        native_bridge::TauriBridge {
            shell: Arc::clone(shell),
        }
        .call(name, args)
    }
}

/// Zero-window tray apps must not exit when their last window closes; only our quit flow may
/// end the process. On exit the daemon is stopped best-effort.
pub fn on_run_event(app: &AppHandle, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            let quitting = app
                .try_state::<SharedShell>()
                .map(|s| s.is_quitting())
                .unwrap_or(true);
            if code.is_none() && !quitting {
                api.prevent_exit();
            }
        }
        tauri::RunEvent::Exit => {
            if let Some(shell) = app.try_state::<SharedShell>() {
                let shell = Arc::clone(&shell);
                let _ = tauri::async_runtime::block_on(async move {
                    tokio::time::timeout(std::time::Duration::from_secs(8), shell.server.shutdown())
                        .await
                });
            }
        }
        _ => {}
    }
    let _ = json!({});
}
