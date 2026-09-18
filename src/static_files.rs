//! The frontend bundle (`frontend/dist/`, built by `npm run build`) with an SPA fallback,
//! plus the boot script injected into index.html: `window.__RCLONE_UI__` carries the mode,
//! capabilities, OS facts and well-known paths the page reads synchronously at import time, and
//! the persisted theme so the first paint is right without localStorage. In debug builds
//! rust-embed reads that folder from disk, so a fresh `npm run build` is picked up without
//! recompiling. `dev_proxy` forwards to a Vite dev server instead (the boot script is still
//! injected).

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use crate::datadir::APP_IDENTIFIER;
use crate::state_files::APP_DOC;
use serde_json::{json, Value};

use crate::Shared;

#[derive(rust_embed::Embed)]
#[folder = "frontend/dist"]
struct Assets;

const MARKER: &str = "<!-- rclone-ui:server-inject -->";

fn path_string(path: Option<std::path::PathBuf>) -> Value {
    path.map(|p| Value::String(p.to_string_lossy().into_owned()))
        .unwrap_or(Value::Null)
}

/// The log directory: on macOS Tauri's app-log directory (`~/Library/Logs/<identifier>`),
/// which the desktop's log plugin writes to; elsewhere `logs/` under the data directory, which
/// is where Tauri's resolver points on Windows and Linux too.
pub fn log_dir_for(dirs: &crate::DataDir) -> std::path::PathBuf {
    if cfg!(target_os = "macos") {
        if let Some(home) = dirs::home_dir() {
            return home.join("Library").join("Logs").join(APP_IDENTIFIER);
        }
    }
    dirs.root.join("logs")
}

pub fn log_dir(st: &Shared) -> Option<std::path::PathBuf> {
    Some(st.log_dir.clone())
}

/// The log file the pages read (About's last lines, bug reports).
pub fn log_file(st: &Shared) -> Option<std::path::PathBuf> {
    log_dir(st).map(|dir| dir.join(crate::logging::FILE_NAME))
}

pub fn boot_payload(st: &Shared) -> Value {
    let app_state = st.store.state_or_default(APP_DOC);
    let theme = app_state
        .get("appearance")
        .and_then(|a| a.get("app"))
        .and_then(Value::as_str)
        .unwrap_or("system");
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "capabilities": st.capabilities,
        "os": {
            "platform": std::env::consts::OS,
            "family": std::env::consts::FAMILY,
            "arch": std::env::consts::ARCH,
            "version": sysinfo::System::os_version().unwrap_or_default(),
            "eol": if cfg!(windows) { "\r\n" } else { "\n" },
        },
        "paths": {
            "sep": std::path::MAIN_SEPARATOR_STR,
            "delimiter": if cfg!(windows) { ";" } else { ":" },
            "home": path_string(dirs::home_dir()),
            "appData": st.ctx.dirs.root,
            "appLog": path_string(log_dir(st)),
            "logFile": path_string(log_file(st)),
            "temp": std::env::temp_dir(),
            // This binary. rclone's `--metadata-mapper` needs a program to run, and the app's
            // mapping editor points it back here (`metadata-map`), so the page has to be able
            // to write the path down. Valid on this machine, which is where the managed daemon
            // runs — a host somewhere else is the page's problem to warn about.
            "exe": path_string(std::env::current_exe().ok()),
            "download": path_string(dirs::download_dir()),
            "desktop": path_string(dirs::desktop_dir()),
        },
        "theme": theme,
        "authRequired": true,
    })
}

pub fn boot_script(st: &Shared) -> String {
    format!(
        "<script>\nwindow.__RCLONE_UI__ = {};\n</script>",
        boot_payload(st)
    )
}

fn inject(html: &str, script: &str) -> String {
    if html.contains(MARKER) {
        html.replacen(MARKER, script, 1)
    } else if let Some(i) = html.find("<script") {
        format!("{}{}\n{}", &html[..i], script, &html[i..])
    } else {
        format!("{}{}", script, html)
    }
}

fn is_html(content_type: Option<&HeaderValue>) -> bool {
    content_type
        .and_then(|v| v.to_str().ok())
        .map(|v| v.starts_with("text/html"))
        .unwrap_or(false)
}

/// The asset key a request path asks for. The path arrives percent-encoded while the keys are
/// the real file names — an icon is named after its rclone type, and `google cloud storage` has
/// spaces — so it is decoded first. A path that could climb out of the bundle is sent to the SPA
/// fallback instead of being looked up: a debug build reads the folder off disk, not the binary.
fn asset_key(raw: &str) -> String {
    let decoded = percent_encoding::percent_decode_str(raw.trim_start_matches('/'))
        .decode_utf8_lossy()
        .into_owned();
    let climbs = decoded.contains('\\')
        || decoded
            .split('/')
            .any(|segment| segment == ".." || segment == "." || segment.is_empty());
    if decoded.is_empty() || climbs {
        return "index.html".to_string();
    }
    decoded
}

pub async fn serve(State(st): State<Shared>, uri: Uri) -> Response {
    if let Some(dev) = &st.dev_proxy {
        return proxy(&st, dev, &uri).await;
    }

    let key = asset_key(uri.path());
    let (path, file) = match Assets::get(&key) {
        Some(file) => (key.as_str(), file),
        None => match Assets::get("index.html") {
            Some(index) => ("index.html", index),
            None => {
                return (
                    StatusCode::NOT_FOUND,
                    "frontend bundle missing: run `npm run build` before building the server",
                )
                    .into_response()
            }
        },
    };
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let mut resp = if path == "index.html" {
        let html = String::from_utf8_lossy(&file.data);
        Body::from(inject(&html, &boot_script(&st))).into_response()
    } else {
        Body::from(file.data.into_owned()).into_response()
    };
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime.as_ref())
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    if path.starts_with("assets/") {
        resp.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    } else {
        resp.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    }
    resp
}

async fn proxy(st: &Shared, dev: &str, uri: &Uri) -> Response {
    let target = format!(
        "{}{}",
        dev.trim_end_matches('/'),
        uri.path_and_query().map(|p| p.as_str()).unwrap_or("/")
    );
    let upstream = match st.http.get(&target).send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!(
                    "dev proxy: {}; is the Vite dev server (`npm run dev`) running at {}?",
                    error_chain(&e),
                    dev
                ),
            )
                .into_response()
        }
    };
    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = upstream.headers().get(header::CONTENT_TYPE).cloned();
    let html = is_html(content_type.as_ref());
    let bytes = match upstream.bytes().await {
        Ok(b) => b,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("dev proxy: {}", error_chain(&e)),
            )
                .into_response()
        }
    };
    let body = if html {
        Body::from(inject(&String::from_utf8_lossy(&bytes), &boot_script(st)))
    } else {
        Body::from(bytes)
    };
    let mut resp = (status, body).into_response();
    if let Some(ct) = content_type {
        resp.headers_mut().insert(header::CONTENT_TYPE, ct);
    }
    resp
}

/// reqwest's `Display` stops at "error sending request"; the cause ("connection refused") is
/// down the `source()` chain.
fn error_chain(e: &dyn std::error::Error) -> String {
    let mut parts = vec![e.to_string()];
    let mut cur = e.source();
    while let Some(src) = cur {
        parts.push(src.to_string());
        cur = src.source();
    }
    parts.join(": ")
}

#[cfg(test)]
mod tests {
    use super::asset_key;

    #[test]
    fn decodes_a_name_that_had_to_be_escaped() {
        assert_eq!(
            asset_key("/icons/backends/google%20cloud%20storage.png"),
            "icons/backends/google cloud storage.png"
        );
        assert_eq!(
            asset_key("/assets/index-abc123.js"),
            "assets/index-abc123.js"
        );
    }

    #[test]
    fn a_path_that_could_climb_out_takes_the_spa_fallback() {
        for raw in [
            "/",
            "/../Cargo.toml",
            "/%2e%2e%2fCargo.toml",
            "/assets/../../Cargo.toml",
            "/assets/%2e%2e%2f%2e%2e%2fCargo.toml",
            "/..%5cCargo.toml",
        ] {
            assert_eq!(asset_key(raw), "index.html", "{raw}");
        }
    }
}
