//! The desktop shell: a thin Tauri app around the embedded `rclone-ui-server`. Every window is
//! a webview pointed at `http://127.0.0.1:<port>/…`; the pages talk to the server exactly like
//! a browser tab would. What only a native app can do — windows, the tray, the global shortcut,
//! deep links, the updater, boot-time dialogs — lives here and is reachable from the pages
//! through the server's native bridge (`/api/native/*`) and bus events.

pub mod boot;
pub mod deeplink;
pub mod interaction;
pub mod native_bridge;
pub mod startup;
pub mod tray;
pub mod updater;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rclone_ui_server::Handle;
use serde_json::Value;
use tauri::AppHandle;

pub struct Shell {
    pub app: AppHandle,
    pub server: Handle,
    /// Set by the quit flow right before `app.exit` / `app.restart`, so the exit-requested
    /// handler lets the process go (a zero-window tray app otherwise never exits).
    quitting: AtomicBool,
    lifecycle_started: AtomicBool,
    /// Deep links that arrived before the lifecycle was up.
    pending_deep_links: Mutex<Vec<String>>,
}

pub type SharedShell = Arc<Shell>;

impl Shell {
    pub fn new(app: AppHandle, server: Handle) -> SharedShell {
        Arc::new(Shell {
            app,
            server,
            quitting: AtomicBool::new(false),
            lifecycle_started: AtomicBool::new(false),
            pending_deep_links: Mutex::new(Vec::new()),
        })
    }

    /// The URL a window loads for `route` (the token handshake, then the route).
    pub fn boot_url(&self, route: &str) -> String {
        self.server.boot_url(route)
    }

    pub fn state(&self) -> &rclone_ui_server::Shared {
        &self.server.state
    }

    pub fn store(&self) -> &rclone_ui_shared::StateStore {
        &self.server.state.store
    }

    /// Publishes an event to every page (and Rust subscriber).
    pub fn emit<T: serde::Serialize>(&self, name: &str, payload: T) {
        self.server.state.ctx.events.emit(name, payload);
    }

    pub fn app_state(&self) -> serde_json::Map<String, Value> {
        self.store()
            .state_or_default(rclone_ui_shared::state_files::APP_DOC)
    }

    pub fn mark_quitting(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    pub fn lifecycle_started(&self) -> bool {
        self.lifecycle_started.load(Ordering::SeqCst)
    }

    pub fn mark_lifecycle_started(&self) {
        self.lifecycle_started.store(true, Ordering::SeqCst);
    }

    pub fn queue_deep_link(&self, url: String) {
        self.pending_deep_links.lock().unwrap().push(url);
    }

    pub fn take_deep_links(&self) -> Vec<String> {
        std::mem::take(&mut *self.pending_deep_links.lock().unwrap())
    }
}

/// The initialization script every window runs before the page: the page's own label, which
/// the native bridge keys window operations on.
pub fn window_script(label: &str) -> String {
    format!(
        "window.__RCLONE_UI_WINDOW__ = {};",
        serde_json::json!({ "label": label })
    )
}

/// Forwards a window's focus/blur/move/theme events to the bus so pages can react to their own
/// window (the Toolbar's blur-to-hide, the Startup's focus loss, the cursor hitbox).
pub fn publish_window_events(shell: &SharedShell, window: &tauri::WebviewWindow) {
    let label = window.label().to_string();
    let shell = Arc::clone(shell);
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Focused(focused) => {
            let name = if *focused {
                "window.focus"
            } else {
                "window.blur"
            };
            shell.emit(
                name,
                serde_json::json!({ "label": label, "focused": focused }),
            );
        }
        tauri::WindowEvent::Moved(position) => {
            shell.emit(
                "window.moved",
                serde_json::json!({ "label": label, "x": position.x, "y": position.y }),
            );
        }
        tauri::WindowEvent::ThemeChanged(theme) => {
            let theme = match theme {
                tauri::Theme::Dark => "dark",
                _ => "light",
            };
            shell.emit("theme.changed", serde_json::json!({ "theme": theme }));
        }
        _ => {}
    });
}
