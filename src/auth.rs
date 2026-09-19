//! One way in: an account (`team.rs`: `POST /api/login {email, password}` → session cookie).
//! Hashed assets and signed download links are public; everything else needs the session.
//! Sessions live in memory: a restart signs everyone out.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::{FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::team::{AuthUser, Team};
use crate::Shared;

pub const COOKIE: &str = "rui_session";
pub const SESSION_HEADER: &str = "x-rcloneui-session";

/// The accounts, their live sessions, and a channel naming users whose sessions were just
/// revoked: an open socket of theirs closes on it (a removed member must not keep receiving
/// events).
pub struct Auth {
    team: Arc<Team>,
    /// Session id → user id. The user is looked up on every request, so a removal or a role
    /// change applies at once.
    sessions: Mutex<HashMap<String, String>>,
    revoked: tokio::sync::broadcast::Sender<String>,
}

impl Auth {
    pub fn new(team: Arc<Team>) -> Auth {
        let (revoked, _) = tokio::sync::broadcast::channel(16);
        Auth {
            team,
            sessions: Mutex::new(HashMap::new()),
            revoked,
        }
    }

    fn login(&self, email: &str, password: &str) -> Option<String> {
        let user = self.team.verify(email, password)?;
        let session = uuid::Uuid::new_v4().to_string();
        self.sessions
            .lock()
            .unwrap()
            .insert(session.clone(), user.id);
        Some(session)
    }

    fn logout(&self, headers: &HeaderMap) {
        if let Some(session) = cookie_value(headers, COOKIE) {
            self.sessions.lock().unwrap().remove(&session);
        }
    }

    /// Ends every session of a user (removed, or their password reset by an admin).
    pub fn revoke_user(&self, id: &str) {
        self.sessions.lock().unwrap().retain(|_, user| user != id);
        let _ = self.revoked.send(id.to_string());
    }

    /// Every user id passed to [`Auth::revoke_user`] from now on.
    pub fn revocations(&self) -> tokio::sync::broadcast::Receiver<String> {
        self.revoked.subscribe()
    }

    /// The account behind the request's cookie.
    pub fn user(&self, headers: &HeaderMap) -> Option<AuthUser> {
        let (team, sessions) = (&self.team, &self.sessions);
        let session = cookie_value(headers, COOKIE)?;
        let id = sessions.lock().unwrap().get(&session).cloned()?;
        team.get(&id)
    }

    pub fn check(&self, headers: &HeaderMap) -> bool {
        self.user(headers).is_some()
    }
}

/// The signed-in account for a handler, put there by [`guard`].
pub struct Caller(pub AuthUser);

impl<S: Send + Sync> FromRequestParts<S> for Caller {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<AuthUser>()
            .cloned()
            .map(Caller)
            .ok_or_else(unauthorized)
    }
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|line| line.split(';'))
        .filter_map(|pair| {
            let (k, v) = pair.trim().split_once('=')?;
            (k == name).then(|| v.to_string())
        })
        .next()
}

fn session_cookie(value: &str, max_age: i64) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{}={}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}",
        COOKIE, value, max_age
    ))
    .expect("cookie header")
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "ok": false, "error": "unauthorized" })),
    )
        .into_response()
}

/// Same-origin check for browsers: a cross-site page can't set custom headers without a CORS
/// preflight (which we never answer), and WebSocket upgrades carry an Origin we compare to Host.
fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true;
    };
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    origin
        .split("://")
        .nth(1)
        .map(|o| o.eq_ignore_ascii_case(host))
        .unwrap_or(false)
}

/// Bundle files a login page needs before there is a session. Only the SPA's own paths: the
/// suffix test must never reach `/api/…`, where an rc-proxy path or a state document name ends
/// in whatever the user (or an attacker) chose — `/api/rc/[fs]/photo.png` is a file
/// served with the daemon's credentials, not an asset.
fn is_public_asset(path: &str) -> bool {
    if path.starts_with("/api/") {
        return false;
    }
    path.starts_with("/assets/")
        || path.starts_with("/icons/")
        || path.starts_with("/fonts/")
        || path.ends_with(".png")
        || path.ends_with(".svg")
        || path.ends_with(".ico")
        || path.ends_with(".wasm")
        || path.ends_with(".js")
        || path.ends_with(".css")
        || path.ends_with(".woff2")
}

pub async fn guard(State(st): State<Shared>, mut req: Request<Body>, next: Next) -> Response {
    let path = req.uri().path();
    let public = path == "/api/login"
        || path == "/api/session"
        || path.starts_with("/api/dl/")
        || is_public_asset(path);
    if public {
        return next.run(req).await;
    }
    let user = st.auth.user(req.headers());
    let authenticated = user.is_some();
    if let Some(user) = user {
        req.extensions_mut().insert(user);
    }
    let path = req.uri().path();
    if path.starts_with("/api/") {
        if !authenticated {
            return unauthorized();
        }
        if path == "/api/ws" && !same_origin(req.headers()) {
            return (StatusCode::FORBIDDEN, "cross-origin websocket").into_response();
        }
        if path.starts_with("/api/rpc/")
            && req.headers().get(SESSION_HEADER).is_none()
        {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "ok": false, "error": "missing X-RcloneUI-Session header" })),
            )
                .into_response();
        }
        return next.run(req).await;
    }
    next.run(req).await
}

#[derive(serde::Deserialize)]
pub struct LoginBody {
    #[serde(default)]
    email: String,
    #[serde(default)]
    password: String,
}

pub async fn login(State(st): State<Shared>, Json(body): Json<LoginBody>) -> Response {
    // argon2 is deliberately slow; keep it off the async workers.
    let state = st.clone();
    let session =
        tokio::task::spawn_blocking(move || state.auth.login(&body.email, &body.password))
            .await
            .unwrap_or(None);
    match session {
        Some(session) => {
            let mut resp = Json(json!({ "ok": true })).into_response();
            resp.headers_mut()
                .insert(header::SET_COOKIE, session_cookie(&session, 30 * 24 * 3600));
            resp
        }
        None => {
            // A flat delay on every miss; cheap brute-force protection on top of the hash cost.
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "ok": false, "error": "wrong email or password" })),
            )
                .into_response()
        }
    }
}

pub async fn logout(State(st): State<Shared>, headers: HeaderMap) -> Response {
    st.auth.logout(&headers);
    let mut resp = Json(json!({ "ok": true })).into_response();
    resp.headers_mut()
        .insert(header::SET_COOKIE, session_cookie("", 0));
    resp
}

pub async fn session(State(st): State<Shared>, headers: HeaderMap) -> Response {
    let user = st.auth.user(&headers);
    Json(json!({
        "ok": true,
        "authenticated": user.is_some(),
        "user": user,
    }))
    .into_response()
}
