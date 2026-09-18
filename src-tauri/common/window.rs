use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::shell::{publish_window_events, window_script, SharedShell};

fn external(shell: &SharedShell, route: &str) -> Result<WebviewUrl, String> {
    let url = shell.boot_url(route);
    url.parse()
        .map(WebviewUrl::External)
        .map_err(|e| format!("bad window url {}: {}", url, e))
}

/// A window that is already open is focused, never reloaded, so the route it was asked for would
/// be lost. It goes out on the bus instead (`window.route`), for the page in that window to
/// follow: the Schedules window opening the task a Transfers row belongs to.
fn announce_route(shell: &SharedShell, label: &str, route: &str) {
    shell.emit(
        "window.route",
        serde_json::json!({ "label": label, "route": route }),
    );
}

#[cfg(target_os = "macos")]
pub fn make_transparent(window: &WebviewWindow) -> Result<(), tauri::Error> {
    use cocoa::{
        appkit::NSColor,
        base::{id, nil},
        foundation::NSString,
    };
    use objc::{class, msg_send, runtime::Object, sel, sel_impl};

    window.with_webview(|webview| unsafe {
        let webview_obj = webview.inner() as *mut Object;
        let no_value: id = msg_send![class!(NSNumber), numberWithBool:0];
        let key = NSString::alloc(nil).init_str("drawsBackground");
        let _: id = msg_send![webview_obj, setValue:no_value forKey:key];
        let _: () = msg_send![key, release];
        let ns_window: id = msg_send![webview_obj, window];
        let bg_color = NSColor::colorWithSRGBRed_green_blue_alpha_(nil, 0.0, 0.0, 0.0, 0.0);
        let _: id = msg_send![ns_window, setBackgroundColor: bg_color];
    })?;

    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn make_transparent(_window: &WebviewWindow) -> Result<(), tauri::Error> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn centered_logical_position(
    app_handle: &AppHandle,
    win_width: f64,
    win_height: f64,
) -> Option<(f64, f64)> {
    let monitor = app_handle
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| app_handle.available_monitors().ok()?.into_iter().next())?;
    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let pos = monitor.position().to_logical::<f64>(scale);
    let x = pos.x + ((size.width - win_width) / 2.0).max(0.0);
    let y = pos.y + ((size.height - win_height) / 2.0).max(0.0);
    Some((x, y))
}

#[cfg(target_os = "linux")]
pub(crate) fn focus_window_linux(app_handle: &AppHandle, window: &WebviewWindow) {
    let window_clone = window.clone();
    let _ = app_handle.run_on_main_thread(move || {
        use gtk::prelude::*;
        if let Ok(gtk_win) = window_clone.gtk_window() {
            let mut time = gtk::current_event_time();
            if time == 0 {
                if let Some(x11_win) = gtk_win
                    .window()
                    .and_then(|w| w.downcast::<gdkx11::X11Window>().ok())
                {
                    time = gdkx11::functions::x11_get_server_time(&x11_win);
                }
            }
            gtk_win.present_with_time(time);
        }
    });
}

#[allow(unused_variables)]
pub fn open_full_window(
    app_handle: &AppHandle,
    shell: &SharedShell,
    name: String,
    route: String,
    hide_title_bar: Option<bool>,
) -> Result<(), String> {
    if let Some(existing) = app_handle.get_webview_window(&name) {
        announce_route(shell, &name, &route);
        existing.set_focus().map_err(|e| e.to_string())?;
        #[cfg(target_os = "linux")]
        focus_window_linux(app_handle, &existing);
        return Ok(());
    }

    let os = std::env::consts::OS;

    let primary_monitor = app_handle
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .or_else(|| app_handle.available_monitors().ok()?.into_iter().next());

    let monitor = primary_monitor.ok_or("No monitor found")?;
    let physical_size = monitor.size();
    let scale_factor = monitor.scale_factor();
    let logical_size = physical_size.to_logical::<f64>(scale_factor);

    let width = logical_size.width;
    let mut height = logical_size.height;

    if os == "windows" {
        height -= 100.0;
    }

    let mut builder = WebviewWindowBuilder::new(app_handle, &name, external(shell, &route)?)
        .initialization_script(window_script(&name))
        .title(&name)
        .inner_size(width, height)
        .resizable(true)
        .visible(false)
        .focused(false)
        .decorations(true)
        .zoom_hotkeys_enabled(false);

    #[cfg(target_os = "linux")]
    if let Some((x, y)) = centered_logical_position(app_handle, width, height) {
        builder = builder.position(x, y);
    }

    #[cfg(target_os = "macos")]
    if hide_title_bar.unwrap_or(false) {
        builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay);
    }

    let window = builder.build().map_err(|e| e.to_string())?;
    publish_window_events(shell, &window);

    std::thread::sleep(std::time::Duration::from_millis(750));

    #[cfg(not(target_os = "linux"))]
    window.center().map_err(|e| e.to_string())?;
    window.set_zoom(1.0).map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    focus_window_linux(app_handle, &window);

    #[cfg(target_os = "linux")]
    if let Some((x, y)) = centered_logical_position(app_handle, width, height) {
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
    }

    #[cfg(target_os = "linux")]
    {
        let window_clone = window.clone();
        app_handle
            .run_on_main_thread(move || {
                use gtk::prelude::*;
                if let Ok(gtk_win) = window_clone.gtk_window() {
                    gtk_win.set_resizable(false);
                    gtk_win.set_resizable(true);
                }
            })
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn open_window(
    app_handle: &AppHandle,
    shell: &SharedShell,
    name: String,
    route: String,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    if let Some(existing) = app_handle.get_webview_window(&name) {
        announce_route(shell, &name, &route);
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let width = width.unwrap_or(840.0);
    let height = height.unwrap_or(725.0);

    #[cfg(target_os = "windows")]
    let (width, height) = {
        let monitor = match app_handle.primary_monitor().map_err(|e| e.to_string())? {
            Some(monitor) => monitor,
            None => app_handle
                .available_monitors()
                .map_err(|e| e.to_string())?
                .into_iter()
                .next()
                .ok_or("No monitors available")?,
        };

        let scale_factor = monitor.scale_factor();
        (width / scale_factor, height / scale_factor)
    };

    let mut builder = WebviewWindowBuilder::new(app_handle, &name, external(shell, &route)?)
        .initialization_script(window_script(&name))
        .title(&name)
        .inner_size(width, height)
        .min_inner_size(650.0, 500.0)
        .max_inner_size(1000.0, 1000.0)
        .resizable(true)
        .visible(false)
        .focused(false)
        .decorations(true)
        .zoom_hotkeys_enabled(false);

    #[cfg(target_os = "macos")]
    {
        builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay);
    }

    let window = builder.build().map_err(|e| e.to_string())?;
    publish_window_events(shell, &window);

    std::thread::sleep(std::time::Duration::from_millis(750));

    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or_else(|| app_handle.primary_monitor().ok().flatten())
        .ok_or("Monitor not found")?;

    let screen_size = monitor.size();
    let monitor_pos = monitor.position();
    let window_size = window.outer_size().map_err(|e| e.to_string())?;

    let x = monitor_pos.x + (screen_size.width as i32 - window_size.width as i32) / 2;
    let y = monitor_pos.y + (screen_size.height as i32 - window_size.height as i32) / 2;

    let count = app_handle.webview_windows().len() as i32;
    let offset = count * 20;
    let sign = if count % 2 != 0 { -1 } else { 1 };
    let final_offset = offset * sign;

    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: x + final_offset,
            y: y + final_offset,
        }))
        .map_err(|e| e.to_string())?;

    window.set_zoom(1.0).map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(target_os = "linux")]
pub fn open_window(
    app_handle: &AppHandle,
    shell: &SharedShell,
    name: String,
    route: String,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    if let Some(existing) = app_handle.get_webview_window(&name) {
        announce_route(shell, &name, &route);
        existing.set_focus().map_err(|e| e.to_string())?;
        #[cfg(target_os = "linux")]
        focus_window_linux(app_handle, &existing);
        return Ok(());
    }

    let width = width.unwrap_or(840.0);
    let height = height.unwrap_or(725.0);

    let mut builder = WebviewWindowBuilder::new(app_handle, &name, external(shell, &route)?)
        .initialization_script(window_script(&name))
        .title(&name)
        .inner_size(width, height)
        .min_inner_size(700.0, 700.0)
        .max_inner_size(1000.0, 1000.0)
        .resizable(true)
        .visible(false)
        .focused(false)
        .decorations(true)
        .zoom_hotkeys_enabled(false);

    if let Some((x, y)) = centered_logical_position(app_handle, width, height) {
        builder = builder.position(x, y);
    }

    let window = builder.build().map_err(|e| e.to_string())?;
    publish_window_events(shell, &window);

    std::thread::sleep(std::time::Duration::from_millis(750));

    window.set_zoom(1.0).map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;

    let window_clone = window.clone();
    app_handle
        .run_on_main_thread(move || {
            use gtk::prelude::*;
            if let Ok(gtk_win) = window_clone.gtk_window() {
                gtk_win.present_with_time(gtk::current_event_time());
                gtk_win.set_resizable(false);
                gtk_win.set_resizable(true);
            }
        })
        .map_err(|e| e.to_string())?;

    Ok(())
}

pub fn open_small_window(
    app_handle: &AppHandle,
    shell: &SharedShell,
    name: String,
    route: String,
) -> Result<(), String> {
    if let Some(existing) = app_handle.get_webview_window(&name) {
        announce_route(shell, &name, &route);
        existing.set_focus().map_err(|e| e.to_string())?;
        #[cfg(target_os = "linux")]
        focus_window_linux(app_handle, &existing);
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(app_handle, &name, external(shell, &route)?)
        .initialization_script(window_script(&name))
        .title(&name)
        .inner_size(800.0, 500.0)
        .resizable(false)
        .visible(false)
        .focused(false)
        .decorations(false)
        .closable(false)
        .shadow(false)
        .zoom_hotkeys_enabled(false);

    #[cfg(target_os = "linux")]
    if let Some((x, y)) = centered_logical_position(app_handle, 800.0, 500.0) {
        builder = builder.position(x, y);
    }

    #[cfg(target_os = "linux")]
    {
        // Transparent WebKitGTK windows can fail to render with Wayland DMA-BUF backends.
        builder = builder.transparent(false);
    }

    let window = builder.build().map_err(|e| e.to_string())?;
    publish_window_events(shell, &window);

    #[cfg(not(target_os = "linux"))]
    window.center().map_err(|e| e.to_string())?;
    window.set_zoom(1.0).map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    if let Err(err) = make_transparent(&window) {
        log::warn!("failed to make small window transparent: {}", err);
    }

    std::thread::sleep(std::time::Duration::from_millis(750));

    window.set_decorations(false).map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    focus_window_linux(app_handle, &window);
    window.set_always_on_top(true).map_err(|e| e.to_string())?;

    #[cfg(target_os = "linux")]
    if let Some((x, y)) = centered_logical_position(app_handle, 800.0, 500.0) {
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
    }

    #[cfg(target_os = "linux")]
    {
        let window_clone = window.clone();
        app_handle
            .run_on_main_thread(move || {
                use gtk::prelude::*;
                if let Ok(gtk_win) = window_clone.gtk_window() {
                    gtk_win.set_resizable(true);
                    gtk_win.set_resizable(false);
                }
            })
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}
