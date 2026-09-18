//! `POST /api/native/{name}` — the host's [`NativeBridge`](crate::NativeBridge): the desktop
//! shell's windows, toolbar and theme. Absent in the standalone server (404).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::rpc::{reply, Reply};
use crate::Shared;

pub async fn handle(
    State(st): State<Shared>,
    Path(name): Path<String>,
    body: Option<Json<Value>>,
) -> Response {
    let Some(bridge) = st.hooks.native.clone() else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": "no native bridge in this deployment" })),
        )
            .into_response();
    };
    let args = body.map(|Json(v)| v).unwrap_or(Value::Null);
    log::debug!("[native] {}", name);
    let result = rclone_ui_shared::rt::spawn_blocking(move || bridge.call(&name, args))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
    reply(result.map(Reply::Json))
}
