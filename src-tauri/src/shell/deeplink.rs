//! `rclone://…` links (lib/deep.ts): `add-template?cmd=…&name=…` opens the Templates window,
//! or hands the payload to it over the bus when it is already open.

use std::sync::Arc;

use serde_json::json;
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

use super::SharedShell;
use crate::window;

const TEMPLATES_WINDOW: &str = "Templates";

fn clean(url: &str) -> String {
    let mut cleaned = url.replacen("rclone:", "", 1);
    while cleaned.starts_with('/') {
        cleaned.remove(0);
    }
    cleaned
}

fn handle(shell: &SharedShell, raw: &str) {
    let url = clean(raw);
    log::info!("[deep-link] {}", url);
    let (route, query) = match url.split_once('?') {
        Some((route, query)) => (route, query),
        None => (url.as_str(), ""),
    };
    let params: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let get = |key: &str| {
        params
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let domain = route.split('/').next().unwrap_or("");
    if domain != "add-template" {
        return;
    }
    let cmd = get("cmd");
    let name = get("name");
    let app = shell.app.clone();
    let shell = Arc::clone(shell);
    tauri::async_runtime::spawn_blocking(move || {
        if app.get_webview_window(TEMPLATES_WINDOW).is_some() {
            // window_open only focuses an existing window (it never re-navigates), so a live
            // Templates window gets the payload over the bus instead of the URL.
            shell.emit(
                "deep-link.add-template",
                json!({ "cmd": cmd, "name": name }),
            );
            let _ = window::open_window(
                &app,
                &shell,
                TEMPLATES_WINDOW.into(),
                "/templates".into(),
                None,
                None,
            );
            return;
        }
        let mut search = url::form_urlencoded::Serializer::new(String::new());
        search.append_pair("action", "add");
        if let Some(cmd) = &cmd {
            search.append_pair("cmd", cmd);
        }
        if let Some(name) = &name {
            search.append_pair("name", name);
        }
        let route = format!("/templates?{}", search.finish());
        if let Err(e) =
            window::open_window(&app, &shell, TEMPLATES_WINDOW.into(), route, None, None)
        {
            log::error!("[deep-link] could not open Templates: {}", e);
        }
    });
}

/// Handles a link now when the lifecycle is up, else queues it for `flush`.
pub fn dispatch(shell: &SharedShell, url: String) {
    super::startup::suppress();
    if shell.lifecycle_started() {
        handle(shell, &url);
    } else {
        shell.queue_deep_link(url);
    }
}

pub fn flush(shell: &SharedShell) {
    for url in shell.take_deep_links() {
        handle(shell, &url);
    }
}

/// Registers the runtime listener and queues the launch link (if any).
pub fn init(shell: &SharedShell) {
    let listener = Arc::clone(shell);
    shell.app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            dispatch(&listener, url.to_string());
        }
    });
    match shell.app.deep_link().get_current() {
        Ok(Some(urls)) => {
            for url in urls {
                dispatch(shell, url.to_string());
            }
        }
        Ok(None) => {}
        Err(e) => log::warn!("[deep-link] get_current failed: {}", e),
    }
}
