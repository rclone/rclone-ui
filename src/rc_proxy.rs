//! `ANY /api/rc/{*path}` — a streaming reverse proxy to the managed (or `--rclone-url`) daemon,
//! with its credentials injected. Bodies stream both ways (multipart uploads, `--rc-serve`
//! downloads with `Range`), there is no body limit and no total timeout.

use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::TryStreamExt;
use serde_json::json;

use crate::{DaemonTarget, Shared};

/// Hop-by-hop headers and the ones we set ourselves.
const SKIP_REQUEST: &[&str] = &[
    "host",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "authorization",
    "cookie",
    "origin",
    "referer",
    "content-length",
    "x-rcloneui-session",
];
const SKIP_RESPONSE: &[&str] = &[
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "set-cookie",
    "access-control-allow-origin",
    "access-control-allow-credentials",
];

fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap_or_default()
        })
        .clone()
}

pub fn unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "error": "the rclone daemon is not running yet", "status": 503 })),
    )
        .into_response()
}

/// Streams `req` to `<daemon>/<path>?<query>` and its response back.
pub async fn forward(daemon: &DaemonTarget, req: Request, path: &str) -> Response {
    let query = req
        .uri()
        .query()
        .map(|q| format!("?{}", q))
        .unwrap_or_default();
    let url = format!(
        "{}/{}{}",
        daemon.base_url,
        path.trim_start_matches('/'),
        query
    );
    let method = req.method().clone();
    let reqwest_method =
        reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET);

    let mut builder = client().request(reqwest_method, &url);
    for (name, value) in req.headers() {
        if SKIP_REQUEST.contains(&name.as_str()) {
            continue;
        }
        builder = builder.header(name.as_str(), value.as_bytes());
    }
    if let Some(user) = &daemon.user {
        builder = builder.basic_auth(user, daemon.pass.as_deref());
    }
    if method != Method::GET && method != Method::HEAD {
        let stream = req
            .into_body()
            .into_data_stream()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e));
        builder = builder.body(reqwest::Body::wrap_stream(stream));
    }

    let upstream = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("rclone unreachable: {}", e), "status": 502 })),
            )
                .into_response()
        }
    };

    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut headers = axum::http::HeaderMap::new();
    for (name, value) in upstream.headers() {
        if SKIP_RESPONSE.contains(&name.as_str()) {
            continue;
        }
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_str().as_bytes()),
            HeaderValue::from_bytes(value.as_bytes()),
        ) {
            headers.append(name, value);
        }
    }
    let body = Body::from_stream(
        upstream
            .bytes_stream()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)),
    );
    let mut resp = (status, body).into_response();
    *resp.headers_mut() = headers;
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp
}

pub async fn handle(
    State(st): State<Shared>,
    Path(path): Path<String>,
    req: Request,
) -> Response {
    let Some(daemon) = st.local_daemon() else {
        return unavailable();
    };
    forward(&daemon, req, &path).await
}
