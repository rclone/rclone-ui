//! `GET/PATCH/PUT /api/state/{doc}` — the page's persisted state (`store/persisted.ts`,
//! `store/host.ts`) as revisioned documents. PATCH sends the top-level keys that changed (`set`)
//! and the ones the page dropped (`unset`) with `If-Match: <revision>`, and gets 409 + the
//! current document when the page was stale.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use crate::state_files::{PatchError, StateDoc};
use serde_json::{json, Map, Value};

use crate::Shared;

fn doc_response(doc: StateDoc) -> Response {
    Json(serde_json::to_value(doc).unwrap_or(Value::Null)).into_response()
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({ "ok": false, "error": message.into() })),
    )
        .into_response()
}

/// An unwritten document reads as revision 0 with an empty state (the page then starts from
/// its defaults); every written document has a revision of at least 1.
pub async fn get(State(st): State<Shared>, Path(doc): Path<String>) -> Response {
    match st.store.read(&doc) {
        Ok(Some(doc)) => doc_response(doc),
        Ok(None) => match st.store.default_version(&doc) {
            Ok(version) => doc_response(StateDoc {
                version,
                revision: 0,
                state: Map::new(),
            }),
            Err(e) => error(StatusCode::BAD_REQUEST, e),
        },
        Err(e) => error(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(serde::Deserialize)]
pub struct PatchBody {
    set: Map<String, Value>,
    #[serde(default)]
    unset: Vec<String>,
}

pub async fn patch(
    State(st): State<Shared>,
    Path(doc): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PatchBody>,
) -> Response {
    let if_match = match if_match(&headers) {
        Ok(value) => value,
        Err(e) => return error(StatusCode::BAD_REQUEST, e),
    };
    match st.store.patch(&doc, body.set, body.unset, if_match) {
        Ok(doc) => doc_response(doc),
        Err(PatchError::Conflict(current)) => (
            StatusCode::CONFLICT,
            Json(serde_json::to_value(current).unwrap_or(Value::Null)),
        )
            .into_response(),
        Err(PatchError::Other(e)) => error(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(serde::Deserialize)]
pub struct PutBody {
    version: u64,
    state: Map<String, Value>,
}

/// `If-Match` as the page sent it: absent means unconditional (Rust writers, tests); present
/// must be a revision, or the write is refused rather than quietly made unconditional.
fn if_match(headers: &HeaderMap) -> Result<Option<u64>, String> {
    let Some(value) = headers.get("if-match") else {
        return Ok(None);
    };
    let text = value
        .to_str()
        .map_err(|_| "invalid If-Match".to_string())?
        .trim()
        .trim_matches('"')
        .to_string();
    text.parse::<u64>()
        .map(Some)
        .map_err(|_| format!("invalid If-Match '{}'", text))
}

pub async fn put(
    State(st): State<Shared>,
    Path(doc): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PutBody>,
) -> Response {
    let if_match = match if_match(&headers) {
        Ok(value) => value,
        Err(e) => return error(StatusCode::BAD_REQUEST, e),
    };
    match st.store.put(&doc, body.version, body.state, if_match) {
        Ok(doc) => doc_response(doc),
        Err(PatchError::Conflict(current)) => (
            StatusCode::CONFLICT,
            Json(serde_json::to_value(current).unwrap_or(Value::Null)),
        )
            .into_response(),
        Err(PatchError::Other(e)) => error(StatusCode::BAD_REQUEST, e),
    }
}
