//! `POST /api/native/{name}` on the desktop: the window operations pages need (open/focus/
//! hide/close, the Toolbar's cursor hitbox and position, dragging, theme), the toolbar and its
//! shortcut. Keyed on the requesting page's window label (from its initialization script).

use rclone_ui_server::NativeBridge;
use serde_json::{json, Value};
use tauri::Manager;

use super::SharedShell;
use crate::shortcut::{set_toolbar_shortcut, show_toolbar_window};
use crate::window;

pub struct TauriBridge {
    pub shell: SharedShell,
}

fn label_of(args: &Value) -> Result<String, String> {
    args["label"]
        .as_str()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .ok_or_else(|| "missing window label".to_string())
}

impl TauriBridge {
    fn window(&self, args: &Value) -> Result<tauri::WebviewWindow, String> {
        let label = label_of(args)?;
        self.shell
            .app
            .get_webview_window(&label)
            .ok_or_else(|| format!("no window '{}'", label))
    }
}

impl NativeBridge for TauriBridge {
    fn call(&self, name: &str, args: Value) -> Result<Value, String> {
        let app = &self.shell.app;
        match name {
            "window_open" => {
                let window_name = args["name"].as_str().ok_or("missing name")?.to_string();
                let route = args["route"].as_str().unwrap_or("/").to_string();
                match args["kind"].as_str().unwrap_or("normal") {
                    "full" => window::open_full_window(
                        app,
                        &self.shell,
                        window_name,
                        route,
                        args["hideTitleBar"].as_bool(),
                    )?,
                    "small" => window::open_small_window(app, &self.shell, window_name, route)?,
                    _ => window::open_window(
                        app,
                        &self.shell,
                        window_name,
                        route,
                        args["width"].as_f64(),
                        args["height"].as_f64(),
                    )?,
                }
                Ok(Value::Null)
            }
            "window_exists" => Ok(Value::Bool(
                app.get_webview_window(&label_of(&args)?).is_some(),
            )),
            "window_focus" => {
                let window = self.window(&args)?;
                window.set_focus().map_err(|e| e.to_string())?;
                #[cfg(target_os = "linux")]
                window::focus_window_linux(app, &window);
                Ok(Value::Null)
            }
            "window_hide" => {
                self.window(&args)?.hide().map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            "window_close" => {
                // Pages close themselves after their work (Mount's OPEN, Startup's TAP TO START);
                // destroy skips the close-requested round trip.
                if let Ok(window) = self.window(&args) {
                    window.destroy().map_err(|e| e.to_string())?;
                }
                Ok(Value::Null)
            }
            "window_is_focused" => Ok(Value::Bool(
                self.window(&args)?
                    .is_focused()
                    .map_err(|e| e.to_string())?,
            )),
            "window_outer_position" => {
                let position = self
                    .window(&args)?
                    .outer_position()
                    .map_err(|e| e.to_string())?;
                Ok(json!({ "x": position.x, "y": position.y }))
            }
            "window_set_ignore_cursor_events" => {
                let ignore = args["ignore"].as_bool().unwrap_or(false);
                self.window(&args)?
                    .set_ignore_cursor_events(ignore)
                    .map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            "window_start_dragging" => {
                self.window(&args)?
                    .start_dragging()
                    .map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            "window_toggle_maximize" => {
                let window = self.window(&args)?;
                if window.is_maximized().map_err(|e| e.to_string())? {
                    window.unmaximize().map_err(|e| e.to_string())?;
                } else {
                    window.maximize().map_err(|e| e.to_string())?;
                }
                Ok(Value::Null)
            }
            "window_set_theme" => {
                let theme = match args["theme"].as_str() {
                    Some("dark") => Some(tauri::Theme::Dark),
                    Some("light") => Some(tauri::Theme::Light),
                    _ => None,
                };
                match args["label"].as_str() {
                    Some(label) => {
                        if let Some(window) = app.get_webview_window(label) {
                            window.set_theme(theme).map_err(|e| e.to_string())?;
                        }
                    }
                    None => {
                        for window in app.webview_windows().values() {
                            let _ = window.set_theme(theme);
                        }
                    }
                }
                Ok(Value::Null)
            }
            "window_lock" | "window_unlock" => {
                let ids: Option<Vec<String>> = serde_json::from_value(args["ids"].clone()).ok();
                let closable = name == "window_unlock";
                for (label, window) in app.webview_windows() {
                    let selected = ids
                        .as_ref()
                        .map(|list| list.contains(&label))
                        .unwrap_or(true);
                    if selected {
                        window.set_closable(closable).map_err(|e| e.to_string())?;
                    }
                }
                Ok(Value::Null)
            }
            "toolbar_show" => {
                show_toolbar_window(app).map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            "toolbar_set_shortcut" => {
                set_toolbar_shortcut(app, args["shortcut"].as_str())?;
                Ok(Value::Null)
            }
            other => Err(format!("unknown native command '{}'", other)),
        }
    }
}
