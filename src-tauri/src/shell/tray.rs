//! The tray icon and its menu (what lib/tray.ts did from the hidden window).

use std::sync::Arc;

use rclone_ui_server::QuitKind;
use serde_json::Value;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, Theme};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use super::SharedShell;
use crate::shortcut::show_toolbar_window;
use crate::window;

const TRAY_ID: &str = "rclone-menu5";

fn icon_path(shell: &SharedShell) -> Result<std::path::PathBuf, String> {
    let app = &shell.app;
    let tray_theme = shell
        .app_state()
        .get("appearance")
        .and_then(|a| a.get("tray"))
        .and_then(Value::as_str)
        .unwrap_or(if cfg!(target_os = "linux") {
            "color"
        } else {
            "system"
        })
        .to_string();
    let suffix = if cfg!(target_os = "linux") && rclone_ui_shared::platform::is_linux_mint() {
        "-padded"
    } else {
        ""
    };
    let file = match tray_theme.as_str() {
        "color" => format!("icons/favicon/icon-color{}.png", suffix),
        "system" => {
            if cfg!(target_os = "macos") {
                "icons/favicon/icon.png".to_string()
            } else {
                let dark = app
                    .webview_windows()
                    .values()
                    .next()
                    .and_then(|w| w.theme().ok())
                    .map(|t| t == Theme::Dark)
                    .unwrap_or(true);
                if dark {
                    format!("icons/favicon/icon{}.png", suffix)
                } else {
                    format!("icons/favicon/icon-light{}.png", suffix)
                }
            }
        }
        "dark" => format!("icons/favicon/icon-light{}.png", suffix),
        _ => format!("icons/favicon/icon{}.png", suffix),
    };
    app.path()
        .resolve(&file, BaseDirectory::Resource)
        .map_err(|e| e.to_string())
}

fn icon(shell: &SharedShell) -> Result<tauri::image::Image<'static>, String> {
    let path = icon_path(shell)?;
    tauri::image::Image::from_path(&path).map_err(|e| format!("{}: {}", path.display(), e))
}

/// The "Open" item shows the shortcut hint once (persisted in `acknowledgements`).
fn open_from_tray(shell: &SharedShell) {
    let acknowledged = shell
        .app_state()
        .get("acknowledgements")
        .and_then(Value::as_array)
        .map(|list| list.iter().any(|v| v.as_str() == Some("openShortcut")))
        .unwrap_or(false);
    if !acknowledged {
        let shortcut = if cfg!(target_os = "macos") {
            "Command + Shift + /"
        } else {
            "Control + Shift + /"
        };
        shell
            .app
            .dialog()
            .message(format!(
                "You can also open the Toolbar using the default shortcut {}.",
                shortcut
            ))
            .title("Did you know?")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCustom("Good to know".into()))
            .blocking_show();
        let _ = shell
            .store()
            .update(rclone_ui_shared::state_files::APP_DOC, |s| {
                let list = s
                    .entry("acknowledgements")
                    .or_insert_with(|| Value::Array(Vec::new()));
                if let Some(list) = list.as_array_mut() {
                    if !list.iter().any(|v| v.as_str() == Some("openShortcut")) {
                        list.push(Value::String("openShortcut".into()));
                    }
                }
            });
    }
    if let Err(e) = show_toolbar_window(&shell.app) {
        log::error!("[tray] show toolbar failed: {}", e);
    }
}

pub fn init(shell: &SharedShell) -> Result<(), String> {
    let app = &shell.app;
    let open = MenuItemBuilder::with_id("open", "Open")
        .build(app)
        .map_err(|e| e.to_string())?;
    let commander = MenuItemBuilder::with_id("commander", "Commander")
        .build(app)
        .map_err(|e| e.to_string())?;
    let transfers = MenuItemBuilder::with_id("transfers", "Transfers")
        .build(app)
        .map_err(|e| e.to_string())?;
    let schedules = MenuItemBuilder::with_id("schedules", "Schedules")
        .build(app)
        .map_err(|e| e.to_string())?;
    let templates = MenuItemBuilder::with_id("templates", "Templates")
        .build(app)
        .map_err(|e| e.to_string())?;
    let settings = MenuItemBuilder::with_id("settings", "Settings")
        .build(app)
        .map_err(|e| e.to_string())?;
    let quit = MenuItemBuilder::with_id("quit", "Quit")
        .build(app)
        .map_err(|e| e.to_string())?;
    let separator1 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let separator2 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let menu = MenuBuilder::with_id(app, "main-menu")
        .items(&[
            &open,
            &separator1,
            &commander,
            &transfers,
            &schedules,
            &templates,
            &separator2,
            &settings,
            &quit,
        ])
        .build()
        .map_err(|e| e.to_string())?;

    let menu_shell = Arc::clone(shell);
    let click_shell = Arc::clone(shell);
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .icon(icon(shell)?)
        .tooltip("Rclone")
        .icon_as_template(true)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(move |app, event| {
            let shell = Arc::clone(&menu_shell);
            let app = app.clone();
            // Off the main thread: opening a window sleeps, the acknowledgement box blocks.
            tauri::async_runtime::spawn_blocking(move || {
                let result = match event.id().as_ref() {
                    "open" => {
                        open_from_tray(&shell);
                        Ok(())
                    }
                    "commander" => window::open_full_window(
                        &app,
                        &shell,
                        "Commander".into(),
                        "/commander".into(),
                        None,
                    ),
                    "transfers" => window::open_window(
                        &app,
                        &shell,
                        "Transfers".into(),
                        "/transfers".into(),
                        None,
                        None,
                    ),
                    "schedules" => window::open_window(
                        &app,
                        &shell,
                        "Schedules".into(),
                        "/schedules".into(),
                        None,
                        None,
                    ),
                    "templates" => window::open_window(
                        &app,
                        &shell,
                        "Templates".into(),
                        "/templates".into(),
                        None,
                        None,
                    ),
                    "settings" => window::open_window(
                        &app,
                        &shell,
                        "Settings".into(),
                        "/settings".into(),
                        None,
                        None,
                    ),
                    "quit" => {
                        rclone_ui_server::server_rpcs::request_quit(shell.state(), QuitKind::Exit);
                        Ok(())
                    }
                    _ => Ok(()),
                };
                if let Err(e) = result {
                    log::error!("[tray] menu action failed: {}", e);
                }
            });
        })
        .on_tray_icon_event(move |tray, event| {
            if cfg!(target_os = "macos") {
                return;
            }
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = click_shell;
                if let Err(e) = show_toolbar_window(tray.app_handle()) {
                    log::error!("[tray] show toolbar failed: {}", e);
                }
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;

    // Re-render the icon when the tray theme setting changes.
    let shell = Arc::clone(shell);
    let mut events = shell.state().ctx.events.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) if event.name == "state.changed" => {
                    let doc = event.payload["doc"].as_str().unwrap_or("");
                    let keys = event.payload["keys"].as_array();
                    let appearance = keys
                        .map(|k| k.iter().any(|v| v.as_str() == Some("appearance")))
                        .unwrap_or(false);
                    if doc == rclone_ui_shared::state_files::APP_DOC && appearance {
                        match icon(&shell) {
                            Ok(image) => {
                                let _ = tray.set_icon(Some(image));
                                let _ = tray.set_icon_as_template(true);
                            }
                            Err(e) => log::warn!("[tray] icon refresh failed: {}", e),
                        }
                    }
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    Ok(())
}
