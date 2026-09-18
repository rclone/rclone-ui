//! `POST /api/proxy` — a fetch executed by the server for the few third-party origins a page
//! needs and a browser can't reach directly (CORS). Strictly allow-listed: this must never be
//! an open proxy.

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Map, Value};

use crate::Shared;

const ALLOWED_HOSTS: &[&str] = &["gateway.filen.io"];

#[derive(serde::Deserialize)]
pub struct ProxyRequest {
    url: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    headers: Map<String, Value>,
    #[serde(default)]
    body: Option<String>,
}

pub async fn handle(State(st): State<Shared>, Json(body): Json<ProxyRequest>) -> Response {
    let fail = |message: String| Json(json!({ "ok": false, "error": message })).into_response();
    let url = match reqwest::Url::parse(&body.url) {
        Ok(url) => url,
        Err(e) => return fail(format!("invalid url: {}", e)),
    };
    let allowed = url.scheme() == "https"
        && url
            .host_str()
            .map(|h| ALLOWED_HOSTS.iter().any(|a| h.eq_ignore_ascii_case(a)))
            .unwrap_or(false);
    if !allowed {
        return fail(format!(
            "requests to {} are not allowed",
            url.host_str().unwrap_or("?")
        ));
    }
    let method = body
        .method
        .as_deref()
        .and_then(|m| reqwest::Method::from_bytes(m.as_bytes()).ok())
        .unwrap_or(reqwest::Method::GET);
    let mut request = st.http.request(method, url);
    for (name, value) in &body.headers {
        if let Some(value) = value.as_str() {
            request = request.header(name, value);
        }
    }
    if let Some(text) = body.body {
        request = request.body(text);
    }
    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => return fail(format!("request failed: {}", e)),
    };
    let status = response.status().as_u16();
    let headers: Map<String, Value> = response
        .headers()
        .iter()
        .map(|(k, v)| {
            (
                k.to_string(),
                Value::String(String::from_utf8_lossy(v.as_bytes()).into_owned()),
            )
        })
        .collect();
    let text = match response.text().await {
        Ok(t) => t,
        Err(e) => return fail(format!("could not read the response: {}", e)),
    };
    Json(json!({ "ok": true, "value": { "status": status, "headers": headers, "body": text } }))
        .into_response()
}
