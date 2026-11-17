use tauri::{AppHandle, Manager, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use super::window::make_transparent;
#[cfg(target_os = "linux")]
use super::window::focus_window_linux;

pub const DEFAULT_TOOLBAR_SHORTCUT: &str = "CmdOrCtrl+Shift+/";
const TOOLBAR_WINDOW_LABEL: &str = "Toolbar";

#[cfg(target_os = "windows")]
const TOOLBAR_WIDTH: f64 = 702.0;
#[cfg(target_os = "windows")]
const TOOLBAR_HEIGHT: f64 = 460.0;

// #[cfg(target_os = "windows")]
// fn refresh_toolbar_bounds(window: &WebviewWindow) -> Result<(), tauri::Error> {
//     // WebView2 can retain stale bounds when this initially-hidden window is shown.
//     // A real resize (for example maximizing the window) fixes the clipped viewport,
//     // so force the same bounds refresh without leaving the toolbar enlarged.
//     window.set_size(tauri::LogicalSize::new(TOOLBAR_WIDTH + 1.0, TOOLBAR_HEIGHT))?;
//     window.set_size(tauri::LogicalSize::new(TOOLBAR_WIDTH, TOOLBAR_HEIGHT))?;
//     Ok(())
// }

fn create_toolbar_window(app_handle: &AppHandle) -> Result<WebviewWindow, tauri::Error> {
    let monitor = match app_handle.primary_monitor()? {
        Some(monitor) => monitor,
        None => app_handle
            .available_monitors()?
            .into_iter()
            .next()
            .ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::NotFound, "No monitors available")
            })?,
    };

    let physical_size = monitor.size();
    let physical_position = monitor.position();

    // On Windows, use logical coordinates with scale factor for proper DPI handling
    #[cfg(target_os = "windows")]
    let builder = {
        let scale_factor = monitor.scale_factor();
        let logical_size = physical_size.to_logical::<f64>(scale_factor);
        let logical_position = physical_position.to_logical::<f64>(scale_factor);

        let toolbar_width = TOOLBAR_WIDTH / scale_factor;
        let toolbar_height = TOOLBAR_HEIGHT / scale_factor;

        // Calculate position in logical pixels, centered on the primary monitor
        let pos_x =
            logical_position.x
            + (logical_size.width - toolbar_width) / 2.0;

        let pos_y =
            logical_position.y
            + logical_size.height / 4.0;

        WebviewWindowBuilder::new(
            app_handle,
            TOOLBAR_WINDOW_LABEL,
            tauri::WebviewUrl::App("/toolbar".into()),
        )
        .title(TOOLBAR_WINDOW_LABEL)
        .inner_size(toolbar_width, toolbar_height)
        .position(pos_x, pos_y)
        .resizable(false)
        .decorations(false)
        .shadow(false)
        .focused(false)
        .visible(false)
        .visible_on_all_workspaces(true)
        .zoom_hotkeys_enabled(false)
    };

    // On macOS and Linux, use logical coordinates (full screen size for click-through)
    #[cfg(not(target_os = "windows"))]
    let builder = {
        let scale_factor = monitor.scale_factor();
        let logical_size = physical_size.to_logical::<f64>(scale_factor);
        let logical_position = physical_position.to_logical::<f64>(scale_factor);

        let pos_x = logical_position.x;
        let pos_y = logical_position.y;

        let mut b = WebviewWindowBuilder::new(
            app_handle,
            TOOLBAR_WINDOW_LABEL,
            tauri::WebviewUrl::App("/toolbar".into()),
        )
        .title(TOOLBAR_WINDOW_LABEL)
        .inner_size(logical_size.width, logical_size.height)
        .position(pos_x, pos_y)
        .resizable(false)
        .decorations(false)
        .shadow(false)
        .focused(false)
        .visible(false)
        .visible_on_all_workspaces(true)
        .zoom_hotkeys_enabled(false);

        #[cfg(target_os = "linux")]
        {
            b = b.transparent(true);
        }

        b
    };

    let window = builder.build()?;

    window.set_zoom(1.0)?;
    window.hide()?;

    #[cfg(target_os = "macos")]
    if let Err(err) = make_transparent(&window) {
        log::warn!("failed to make toolbar window transparent: {}", err);
    }

    Ok(window)
}

pub fn ensure_toolbar_window(app_handle: &AppHandle) -> Result<(), tauri::Error> {
    if app_handle
        .get_webview_window(TOOLBAR_WINDOW_LABEL)
        .is_none()
    {
        create_toolbar_window(app_handle)?;
    }
    Ok(())
}

pub fn show_toolbar_window(app_handle: &AppHandle) -> Result<(), tauri::Error> {
    ensure_toolbar_window(app_handle)?;

    if let Some(window) = app_handle.get_webview_window(TOOLBAR_WINDOW_LABEL) {
        window.show()?;
        window.unminimize()?;
        // #[cfg(target_os = "windows")]
        // refresh_toolbar_bounds(&window)?;
        window.set_focus()?;
        window.set_skip_taskbar(true)?;
        window.set_always_on_top(true)?;
        #[cfg(target_os = "linux")]
        focus_window_linux(app_handle, &window);
    }

    Ok(())
}

fn open_toolbar(app_handle: &AppHandle) -> Result<(), tauri::Error> {
    ensure_toolbar_window(app_handle)?;

    if let Some(window) = app_handle.get_webview_window(TOOLBAR_WINDOW_LABEL) {
        if window.is_visible()? {
            window.hide()?;
        } else {
            window.show()?;
            window.unminimize()?;
            // #[cfg(target_os = "windows")]
            // refresh_toolbar_bounds(&window)?;
            window.set_focus()?;
            window.set_skip_taskbar(true)?;
            window.set_always_on_top(true)?;
            #[cfg(target_os = "linux")]
            focus_window_linux(app_handle, &window);
        }
    }

    Ok(())
}

fn parse_shortcut(shortcut: &str) -> Result<Shortcut, String> {
    shortcut.parse::<Shortcut>().map_err(|e| e.to_string())
}

fn register_toolbar_shortcut(app_handle: &AppHandle, shortcut: &str) -> Result<(), String> {
    let parsed = parse_shortcut(shortcut)?;
    app_handle
        .global_shortcut()
        .on_shortcut(parsed, |app, _shortcut, event| {
            if matches!(event.state(), ShortcutState::Pressed) {
                if let Err(err) = open_toolbar(app) {
                    log::error!("failed to open toolbar via shortcut: {}", err);
                }
            }
        })
        .map_err(|e| e.to_string())
}

pub fn set_toolbar_shortcut(app_handle: &AppHandle, shortcut: Option<&str>) -> Result<(), String> {
    let shortcut = shortcut
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    app_handle
        .global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())?;

    if let Some(shortcut) = shortcut {
        register_toolbar_shortcut(app_handle, shortcut.as_str())?;
    }

    Ok(())
}
