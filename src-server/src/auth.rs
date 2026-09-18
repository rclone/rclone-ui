//! Two ways in: accounts (`team.rs`: `POST /api/login {email, password}` → session cookie) and
//! the desktop's launch token (a per-launch secret the shell hands to each window through
//! `/__boot`, which turns it into the same cookie; `Authorization: Bearer` works too). Hashed
//! assets and signed download links are public; everything else needs the session. Sessions live
//! in memory: a restart signs everyone out.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::{FromRequestParts, Query, Request, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use serde_json::json;

use crate::team::{AuthUser, Team};
use crate::{AuthMode, Shared};

pub const COOKIE: &str = "rui_session";
pub const SESSION_HEADER: &str = "x-rcloneui-session";

enum Inner {
    Users {
        team: Arc<Team>,
        /// Session id → user id. The user is looked up on every request, so a removal or a
        /// role change applies at once.
        sessions: Mutex<HashMap<String, String>>,
    },
    Token(String),
}

/// The sessions, and a channel naming users whose sessions were just revoked: an open socket
/// of theirs closes on it (a removed member must not keep receiving events).
pub struct Auth(Inner, tokio::sync::broadcast::Sender<String>);

impl Auth {
    /// Returns the launch token in token mode so the host can build boot URLs.
    pub fn new(mode: AuthMode, team: Arc<Team>) -> (Auth, Option<String>) {
        let (revoked, _) = tokio::sync::broadcast::channel(16);
        match mode {
            AuthMode::Users { .. } => (
                Auth(
                    Inner::Users {
                        team,
                        sessions: Mutex::new(HashMap::new()),
                    },
                    revoked,
                ),
                None,
            ),
            AuthMode::Token => {
                let token = format!(
                    "{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple()
                );
                (Auth(Inner::Token(token.clone()), revoked), Some(token))
            }
        }
    }

    pub fn mode(&self) -> &'static str {
        match &self.0 {
            Inner::Users { .. } => "users",
            Inner::Token(_) => "token",
        }
    }

    /// Whether pages have to sign in (drives the login route).
    pub fn required(&self) -> bool {
        matches!(self.0, Inner::Users { .. })
    }

    fn login(&self, email: &str, password: &str) -> Option<String> {
        let Inner::Users { team, sessions } = &self.0 else {
            return None;
        };
        let user = team.verify(email, password)?;
        let session = uuid::Uuid::new_v4().to_string();
        sessions.lock().unwrap().insert(session.clone(), user.id);
        Some(session)
    }

    fn logout(&self, headers: &HeaderMap) {
        if let Inner::Users { sessions, .. } = &self.0 {
            if let Some(session) = cookie_value(headers, COOKIE) {
                sessions.lock().unwrap().remove(&session);
            }
        }
    }

    /// Ends every session of a user (removed, or their password reset by an admin).
    pub fn revoke_user(&self, id: &str) {
        if let Inner::Users { sessions, .. } = &self.0 {
            sessions.lock().unwrap().retain(|_, user| user != id);
        }
        let _ = self.1.send(id.to_string());
    }

    /// Every user id passed to [`Auth::revoke_user`] from now on.
    pub fn revocations(&self) -> tokio::sync::broadcast::Receiver<String> {
        self.1.subscribe()
    }

    /// The account behind the request's cookie (`None` in token mode or without a session).
    pub fn user(&self, headers: &HeaderMap) -> Option<AuthUser> {
        let Inner::Users { team, sessions } = &self.0 else {
            return None;
        };
        let session = cookie_value(headers, COOKIE)?;
        let id = sessions.lock().unwrap().get(&session).cloned()?;
        team.get(&id)
    }

    fn token_matches(&self, candidate: &str) -> bool {
        use subtle::ConstantTimeEq;
        match &self.0 {
            Inner::Token(token) => token.as_bytes().ct_eq(candidate.as_bytes()).into(),
            _ => false,
        }
    }

    pub fn check(&self, headers: &HeaderMap) -> bool {
        match &self.0 {
            Inner::Users { .. } => self.user(headers).is_some(),
            Inner::Token(_) => {
                if let Some(cookie) = cookie_value(headers, COOKIE) {
                    if self.token_matches(&cookie) {
                        return true;
                    }
                }
                headers
                    .get(header::AUTHORIZATION)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.strip_prefix("Bearer "))
                    .map(|t| self.token_matches(t.trim()))
                    .unwrap_or(false)
            }
        }
    }
}

/// The signed-in account for a handler, put there by [`guard`] (`None` in token mode).
pub struct Caller(pub Option<AuthUser>);

impl<S: Send + Sync> FromRequestParts<S> for Caller {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(Caller(parts.extensions.get::<AuthUser>().cloned()))
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
/// in whatever the user (or an attacker) chose — `/api/rc/<host>/[fs]/photo.png` is a file
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
    let public = path == "/__boot"
        || path == "/api/login"
        || path == "/api/session"
        || path.starts_with("/api/dl/")
        || is_public_asset(path);
    if public {
        return next.run(req).await;
    }
    let user = st.auth.user(req.headers());
    let authenticated = match &user {
        Some(_) => true,
        None => st.auth.mode() == "token" && st.auth.check(req.headers()),
    };
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
        if (path.starts_with("/api/rpc/") || path.starts_with("/api/native/"))
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
    // HTML: token mode has no login page, so an unauthenticated tab gets nothing.
    if st.auth.mode() == "token" && !authenticated {
        return (
            StatusCode::UNAUTHORIZED,
            "This Rclone UI instance only serves its own windows.",
        )
            .into_response();
    }
    next.run(req).await
}

#[derive(serde::Deserialize)]
pub struct BootQuery {
    t: String,
    #[serde(default)]
    next: Option<String>,
}

/// Token mode: `GET /__boot?t=<token>&next=/route` → session cookie + redirect. The token
/// never appears in a page URL afterwards.
pub async fn boot(State(st): State<Shared>, Query(query): Query<BootQuery>) -> Response {
    if !st.auth.token_matches(&query.t) {
        return (StatusCode::UNAUTHORIZED, "bad launch token").into_response();
    }
    let next = query
        .next
        .filter(|n| n.starts_with('/') && !n.starts_with("//"))
        .unwrap_or_else(|| "/".to_string());
    let mut resp = Redirect::to(&next).into_response();
    resp.headers_mut().insert(
        header::SET_COOKIE,
        session_cookie(&query.t, 365 * 24 * 3600),
    );
    resp
}

#[derive(serde::Deserialize)]
pub struct LoginBody {
    #[serde(default)]
    email: String,
    #[serde(default)]
    password: String,
}

pub async fn login(State(st): State<Shared>, Json(body): Json<LoginBody>) -> Response {
    if !st.auth.required() {
        return Json(json!({ "ok": true, "required": false })).into_response();
    }
    // argon2 is deliberately slow; keep it off the async workers.
    let state = st.clone();
    let session =
        tokio::task::spawn_blocking(move || state.auth.login(&body.email, &body.password))
            .await
            .unwrap_or(None);
    match session {
        Some(session) => {
            let mut resp = Json(json!({ "ok": true, "required": true })).into_response();
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
        "mode": st.auth.mode(),
        "required": st.auth.required(),
        "authenticated": user.is_some() || (st.auth.mode() == "token" && st.auth.check(&headers)),
        "user": user,
    }))
    .into_response()
}
