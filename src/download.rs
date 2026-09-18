//! `GET /api/dl/{token}` — a short-lived link to a file on a daemon (`download_link` mints it).
//! It exists because a download opened with `window.open` from a desktop window lands in the
//! system browser, which has no session cookie; the token is the credential.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::Shared;

const TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone)]
struct Target {
    /// `[fs]/remote` as rclone's `--rc-serve` expects it, already percent-encoded.
    path: String,
    filename: String,
    minted: Instant,
}

#[derive(Default)]
pub struct Downloads {
    tokens: Mutex<HashMap<String, Target>>,
}

fn encode_segment(segment: &str) -> String {
    percent_encoding::utf8_percent_encode(segment, percent_encoding::NON_ALPHANUMERIC).to_string()
}

/// `[fs]/a/b/c.txt` with every path segment encoded (rclone decodes them).
pub fn serve_path(fs: &str, remote: &str) -> String {
    let segments: Vec<String> = remote
        .split('/')
        .filter(|s| !s.is_empty())
        .map(encode_segment)
        .collect();
    format!("[{}]/{}", encode_segment(fs), segments.join("/"))
}

impl Downloads {
    pub fn mint(&self, fs: &str, remote: &str) -> String {
        let mut tokens = self.tokens.lock().unwrap();
        let now = Instant::now();
        tokens.retain(|_, t| now.duration_since(t.minted) < TTL);
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let filename = remote
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or("download")
            .to_string();
        tokens.insert(
            token.clone(),
            Target {
                path: serve_path(fs, remote),
                filename,
                minted: now,
            },
        );
        token
    }

    fn get(&self, token: &str) -> Option<Target> {
        let tokens = self.tokens.lock().unwrap();
        tokens
            .get(token)
            .filter(|t| t.minted.elapsed() < TTL)
            .cloned()
    }
}

pub async fn handle(State(st): State<Shared>, Path(token): Path<String>, req: Request) -> Response {
    let Some(target) = st.downloads.get(&token) else {
        return (StatusCode::NOT_FOUND, "this download link has expired").into_response();
    };
    let Some(daemon) = st.local_daemon() else {
        return crate::rc_proxy::unavailable();
    };
    let mut resp = crate::rc_proxy::forward(&daemon, req, &target.path).await;
    if resp.status().is_success() {
        let disposition = format!(
            "attachment; filename*=UTF-8''{}",
            encode_segment(&target.filename)
        );
        if let Ok(value) = HeaderValue::from_str(&disposition) {
            resp.headers_mut()
                .insert(header::CONTENT_DISPOSITION, value);
        }
    }
    resp
}
