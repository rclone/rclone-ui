//! `POST /api/rpc/{name}` — the page's `rpc(name, args)`. The JSON body is the args object
//! (or empty). Replies `{ok:true, value}` / `{ok:false, error}`. Streaming commands take a
//! `stream` id in their args; events then arrive on the page's WebSocket. Resolution order: the
//! server's own RPCs, then the shared command table. Bytes never travel here: files go through
//! `/api/rc` and `/api/dl`.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Json;
use rclone_ui_shared::commands;
use serde_json::{json, Value};

use crate::auth::{Caller, SESSION_HEADER};
use crate::Shared;

pub enum Reply {
    Json(Value),
}

pub fn ok<T: serde::Serialize>(value: T) -> Result<Reply, String> {
    serde_json::to_value(value)
        .map(Reply::Json)
        .map_err(|e| format!("failed to serialize the result: {}", e))
}

pub fn reply(result: Result<Reply, String>) -> Response {
    match result {
        Ok(Reply::Json(value)) => Json(json!({ "ok": true, "value": value })).into_response(),
        Err(error) => Json(json!({ "ok": false, "error": error })).into_response(),
    }
}

/// The page's session id (`X-RcloneUI-Session`), which its WebSocket said hello with.
pub fn session_of(headers: &HeaderMap) -> String {
    headers
        .get(SESSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

pub async fn handle(
    State(st): State<Shared>,
    Path(name): Path<String>,
    headers: HeaderMap,
    Caller(caller): Caller,
    body: Bytes,
) -> Response {
    let session = session_of(&headers);
    let args = if body.is_empty() {
        Value::Null
    } else {
        match serde_json::from_slice::<Value>(&body) {
            Ok(v) => v,
            Err(e) => return reply(Err(format!("invalid JSON arguments: {}", e))),
        }
    };

    log::debug!("[rpc] {}", name);

    let stream_id = args
        .get("stream")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    let sink = stream_id
        .as_deref()
        .map(|id| st.sessions.stream_sink(&session, id));

    if let Some(result) = crate::server_rpcs::handle(
        &st,
        &session,
        caller.as_ref(),
        &name,
        args.clone(),
        sink.clone(),
    )
    .await
    {
        return reply(result);
    }

    if commands::is_streaming(&name) && sink.is_none() {
        return reply(Err(format!("'{}' needs a stream id", name)));
    }
    reply(
        commands::dispatch(&st.ctx, &name, args, sink)
            .await
            .map(Reply::Json),
    )
}
