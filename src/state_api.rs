//! `GET/PATCH/PUT /api/state/{doc}` — the page's persisted state (`store/persisted.ts`) as a
//! revisioned document. PATCH sends the top-level keys that changed (`set`) and the ones the
//! page dropped (`unset`) with `If-Match: <revision>`, and gets 409 + the current document when
//! the page was stale. `app` is the only document; any other name is refused.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Map, Value};

use crate::state::{PatchError, StateDoc, APP_DOC, APP_VERSION};
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

/// The one name the route answers to; the accounts file sits beside the document, and no name
/// may reach it or anything else.
fn known(doc: &str) -> Result<(), Response> {
    if doc == APP_DOC {
        Ok(())
    } else {
        Err(error(
            StatusCode::BAD_REQUEST,
            format!("unknown state document '{}'", doc),
        ))
    }
}

fn conflict_or_error(e: PatchError) -> Response {
    match e {
        PatchError::Conflict(current) => (
            StatusCode::CONFLICT,
            Json(serde_json::to_value(current).unwrap_or(Value::Null)),
        )
            .into_response(),
        PatchError::Other(e) => error(StatusCode::BAD_REQUEST, e),
    }
}

/// An unwritten document reads as revision 0 with an empty state (the page then starts from
/// its defaults); every written document has a revision of at least 1.
pub async fn get(State(st): State<Shared>, Path(doc): Path<String>) -> Response {
    if let Err(refused) = known(&doc) {
        return refused;
    }
    match st.store.read() {
        Ok(Some(doc)) => doc_response(doc),
        Ok(None) => doc_response(StateDoc {
            version: APP_VERSION,
            revision: 0,
            state: Map::new(),
        }),
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
    if let Err(refused) = known(&doc) {
        return refused;
    }
    let if_match = match if_match(&headers) {
        Ok(value) => value,
        Err(e) => return error(StatusCode::BAD_REQUEST, e),
    };
    match st.store.patch(body.set, body.unset, if_match) {
        Ok(doc) => doc_response(doc),
        Err(e) => conflict_or_error(e),
    }
}

#[derive(serde::Deserialize)]
pub struct PutBody {
    version: u64,
    state: Map<String, Value>,
}

/// `If-Match` as the page sent it: absent means unconditional; present must be a revision, or
/// the write is refused rather than quietly made unconditional.
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
    if let Err(refused) = known(&doc) {
        return refused;
    }
    let if_match = match if_match(&headers) {
        Ok(value) => value,
        Err(e) => return error(StatusCode::BAD_REQUEST, e),
    };
    match st.store.put(body.version, body.state, if_match) {
        Ok(doc) => doc_response(doc),
        Err(e) => conflict_or_error(e),
    }
}
