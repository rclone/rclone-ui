//! `POST /api/rpc/{name}` — the page's `rpc(name, args)`: one table, one dispatch. The JSON body
//! is the args object (or empty); the reply is `{ok:true, value}` or `{ok:false, error}`. Every
//! RPC is an arm of `rpcs!` below, and the arm list is `RPC_NAMES` (`list-commands`). A body that
//! blocks (files, argon2, a binary probe) goes to the blocking pool inside its arm; progress goes
//! over the bus (`app.update.progress`, `rclone.download-progress`), never through this reply.
//! Bytes never travel here: files go through `/api/rc` and `/api/dl`.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::auth::Caller;
use crate::lifecycle::{resolve, RestartOverrides};
use crate::team::{AuthUser, Role};
use crate::transfers::service::StartRequest;
use crate::{notifications, scheduler, transfers, QuitKind, Shared};

pub async fn status(State(st): State<Shared>) -> Response {
    Json(st.status()).into_response()
}

pub async fn handle(
    State(st): State<Shared>,
    Path(name): Path<String>,
    Caller(caller): Caller,
    body: Bytes,
) -> Response {
    let args = if body.is_empty() {
        Value::Null
    } else {
        match serde_json::from_slice::<Value>(&body) {
            Ok(v) => v,
            Err(e) => return reply(Err(format!("invalid JSON arguments: {}", e))),
        }
    };
    log::debug!("[rpc] {}", name);
    reply(dispatch(&st, &caller, &name, args).await)
}

fn reply(result: Result<Value, String>) -> Response {
    match result {
        Ok(value) => Json(json!({ "ok": true, "value": value })).into_response(),
        Err(error) => Json(json!({ "ok": false, "error": error })).into_response(),
    }
}

/// The arguments as a typed struct (`camelCase` keys, as the page sends them); `null` is none.
fn parse<T: DeserializeOwned>(args: &Value) -> Result<T, String> {
    let args = if args.is_null() {
        Value::Object(Default::default())
    } else {
        args.clone()
    };
    serde_json::from_value(args).map_err(|e| format!("invalid arguments: {}", e))
}

fn str_arg(args: &Value, key: &str) -> Result<String, String> {
    args[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing '{}'", key))
}

fn ok<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| format!("failed to serialize the result: {}", e))
}

/// A body that blocks, off the async workers.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

fn cap(st: &Shared, name: &str) -> bool {
    st.capabilities[name].as_bool().unwrap_or(false)
}

/// The origin of rclone's OAuth callback server, and the login's own `state`, read from the
/// daemon rather than from the page. rclone binds that server to its own loopback on a port of
/// its choosing, so the page can neither reach it (in a browser tab `127.0.0.1` is the laptop,
/// not the server) nor be trusted to name it: taking it from `config/oauthstatus` means the two
/// OAuth RPCs never fetch a URL somebody else picked.
async fn oauth_callback(st: &Shared) -> Result<(String, String, String), String> {
    let daemon = st
        .local_daemon()
        .ok_or_else(|| "the rclone daemon is not running".to_string())?;
    let status = daemon
        .client()
        .call("/config/oauthstatus", &json!({}))
        .await?;
    if status["status"].as_str() != Some("running") {
        return Err("no sign-in is waiting".into());
    }
    let auth_url = status["authUrl"]
        .as_str()
        .ok_or_else(|| "the daemon reported no sign-in link".to_string())?;
    let parsed = reqwest::Url::parse(auth_url).map_err(|e| e.to_string())?;
    let state = parsed
        .query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned())
        .ok_or_else(|| "the sign-in link carries no state".to_string())?;
    Ok((
        auth_url.to_string(),
        parsed.origin().ascii_serialization(),
        state,
    ))
}

/// How long a reconnect claim stands without being released. Long enough for a sign-in that
/// goes through another machine, short enough that a page which went away does not silence the
/// prompt until the process restarts.
const RECONNECT_CLAIM_TTL: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// Starts the quit/relaunch flow (once); returns `false` when it is already running.
pub fn request_quit(st: &Shared, kind: QuitKind) -> bool {
    if !st.begin_quit() {
        return false;
    }
    let st = st.clone();
    tokio::spawn(quit(st, kind));
    true
}

/// The quit/relaunch flow, once: stop the daemon, then exit.
async fn quit(st: Shared, kind: QuitKind) {
    if let Some(supervisor) = st.supervisor() {
        supervisor.shutdown().await;
    }
    crate::exit(kind);
}

/// The table: the arm list is the dispatch, and the names it carries are `RPC_NAMES`. Adding an
/// RPC is adding an arm. Bodies see `st`, the signed-in `caller` and the page's `args`.
macro_rules! rpcs {
    ($st:ident, $caller:ident, $args:ident; $( $name:literal => $body:expr, )*) => {
        /// Every RPC the server answers, by wire name.
        pub const RPC_NAMES: &[&str] = &[ $( $name, )* ];

        pub async fn dispatch(
            $st: &Shared,
            $caller: &AuthUser,
            name: &str,
            $args: Value,
        ) -> Result<Value, String> {
            match name {
                $( $name => $body, )*
                other => Err(format!("unknown command '{}'", other)),
            }
        }
    };
}

rpcs! { st, caller, args;
    // --- the page's console, into the server's log --------------------------------------------
    "log" => {
        let level = args["level"].as_str().unwrap_or("info");
        let message = args["message"].as_str().unwrap_or("");
        let target = format!(
            "page{}",
            args["label"]
                .as_str()
                .map(|l| format!(":{}", l))
                .unwrap_or_default()
        );
        match level {
            "error" => log::error!(target: "page", "[{}] {}", target, message),
            "warn" => log::warn!(target: "page", "[{}] {}", target, message),
            "debug" => log::debug!(target: "page", "[{}] {}", target, message),
            "trace" => log::trace!(target: "page", "[{}] {}", target, message),
            _ => log::info!(target: "page", "[{}] {}", target, message),
        }
        ok(Value::Null)
    },

    // --- this process ---------------------------------------------------------------------------
    "app_relaunch" => {
        if !cap(st, "processExit") {
            return Err("The process is managed by its container; restart it from there.".into());
        }
        request_quit(st, QuitKind::Relaunch);
        ok(Value::Null)
    },
    "app_update_check" => {
        if !cap(st, "updater") {
            return Err("Updates are not available in this deployment.".into());
        }
        ok(crate::updater::check().await?)
    },
    "app_update_install" => {
        if !cap(st, "updater") {
            return Err("Updates are not available in this deployment.".into());
        }
        crate::updater::install(&st.bus).await?;
        ok(Value::Null)
    },
    // One "reconnect?" dialog per remote, app-wide: the first page to ask gets it, and gives it
    // back when it is done. A page that was closed mid-dialog never releases its claim, and one
    // this old is treated as gone rather than held.
    "claim_reconnect_dialog" => {
        let key = str_arg(&args, "remote")?;
        let mut claims = st.reconnect_claims.lock().unwrap();
        let now = std::time::Instant::now();
        let granted =
            !matches!(claims.get(&key), Some(at) if now.duration_since(*at) < RECONNECT_CLAIM_TTL);
        if granted {
            claims.insert(key, now);
        }
        ok(granted)
    },
    "release_reconnect_dialog" => {
        st.reconnect_claims.lock().unwrap().remove(&str_arg(&args, "remote")?);
        ok(true)
    },

    // --- accounts (Settings › Team). The rules live in `team.rs`; these read arguments and end
    // the sessions of whoever lost access. Hashing runs on the blocking pool. --------------------
    "team_list" => ok(st.team.list()),
    "team_add" => {
        let (team, caller) = (st.team.clone(), caller.clone());
        let email = str_arg(&args, "email")?;
        let password = str_arg(&args, "password")?;
        let role = Role::parse(args["role"].as_str().unwrap_or("member"))
            .ok_or_else(|| "Invalid role.".to_string())?;
        ok(blocking(move || team.add(&caller, &email, &password, role)).await?)
    },
    "team_remove" => {
        let id = str_arg(&args, "id")?;
        st.team.remove(caller, &id)?;
        st.auth.revoke_user(&id);
        ok(true)
    },
    "team_set_role" => {
        let id = str_arg(&args, "id")?;
        let role =
            Role::parse(&str_arg(&args, "role")?).ok_or_else(|| "Invalid role.".to_string())?;
        ok(st.team.set_role(caller, &id, role)?)
    },
    "team_set_password" => {
        let (team, caller) = (st.team.clone(), caller.clone());
        let id = str_arg(&args, "id")?;
        let password = str_arg(&args, "password")?;
        let current = args["current"].as_str().map(|s| s.to_string());
        let own = id == caller.id;
        let target = id.clone();
        blocking(move || team.set_password(&caller, &target, current.as_deref(), &password)).await?;
        // A reset by an admin ends the member's sessions; your own change keeps yours.
        if !own {
            st.auth.revoke_user(&id);
        }
        ok(true)
    },
    "team_set_email" => {
        let id = str_arg(&args, "id")?;
        let email = str_arg(&args, "email")?;
        ok(st.team.set_email(caller, &id, &email)?)
    },

    // --- the rclone daemon and its binary (Settings › Rclone) -----------------------------------
    "rclone_restart" => {
        let supervisor = st
            .supervisor()
            .ok_or("the rclone daemon is external (--rclone-url); nothing to restart")?;
        let overrides: Option<RestartOverrides> = match args.get("overrides") {
            Some(v) if !v.is_null() => {
                Some(serde_json::from_value(v.clone()).map_err(|e| e.to_string())?)
            }
            _ => None,
        };
        supervisor.request_restart(overrides);
        ok(Value::Null)
    },
    "rclone_releases" => {
        let limit = args["limit"].as_u64().unwrap_or(20) as usize;
        ok(resolve::available_releases(limit).await?)
    },
    // Which rclone runs, and whether a version can be installed over it. `installBlocked` is the
    // reason when it cannot.
    "rclone_binary" => match st.supervisor() {
        None => ok(json!({ "kind": "external" })),
        Some(supervisor) => {
            let pinned = supervisor.pinned().map(std::path::Path::to_path_buf);
            let (dirs, named) = (st.dirs.clone(), pinned.clone());
            let found = tokio::task::spawn_blocking(move || {
                resolve::find_binary(&dirs, named.as_deref())
            })
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or(None);
            let custom = crate::scheduler::storeread::read_root(&st.dirs)
                .ok()
                .and_then(|root| root.rclone_path)
                .filter(|path| !path.is_empty());
            let target = crate::zookeeper::install_target(pinned.as_deref());
            ok(json!({
                "path": found.as_ref().map(|f| &f.path),
                "version": found.as_ref().map(|f| &f.version),
                "kind": found.as_ref().map(|f| f.kind),
                "custom": custom,
                "installTarget": target.as_ref().ok().map(|t| t.to_string_lossy()),
                "installBlocked": target.as_ref().err(),
            }))
        }
    },
    // Replaces the server's own rclone where it lives. A custom binary is never written to: the
    // setting is cleared, so what was installed is what runs.
    "rclone_install" => {
        let supervisor = st.supervisor().ok_or(
            "the rclone daemon is external (--rclone-url): update it on its own machine",
        )?;
        let version = str_arg(&args, "version")?;
        let target = crate::zookeeper::install_target(supervisor.pinned()).map_err(|reason| {
            format!(
                "{} Run `rclone selfupdate --version {}` on the server instead.",
                reason, version
            )
        })?;
        let proxy = resolve::host_proxy(&st.dirs);
        crate::zookeeper::install_rclone(&st.dirs, &st.bus, &version, &target, proxy).await?;
        st.store.update(crate::state_files::APP_DOC, |s| {
            s.remove("rclonePath");
        })?;
        supervisor.request_restart(None);
        ok(target.to_string_lossy())
    },
    // `path: null` goes back to the server's own rclone. One older than the minimum is refused
    // here, so it cannot be what stops the next start.
    "rclone_set_custom" => {
        let supervisor = st.supervisor().ok_or("the rclone daemon is external (--rclone-url)")?;
        if supervisor.pinned().is_some() {
            return Err("rclone is pinned by --rclone-path.".to_string());
        }
        let custom = args["path"].as_str().map(str::trim).filter(|p| !p.is_empty());
        if let Some(path) = custom {
            let binary = std::path::PathBuf::from(path);
            let version = blocking(move || crate::zookeeper::probe_rclone_version(&binary)).await?;
            crate::zookeeper::check_minimum(&version, path)?;
        }
        st.store.update(crate::state_files::APP_DOC, |s| match custom {
            Some(path) => {
                s.insert("rclonePath".into(), Value::String(path.to_string()));
            }
            None => {
                s.remove("rclonePath");
            }
        })?;
        supervisor.request_restart(None);
        ok(Value::Null)
    },
    "mount_support" => ok(crate::lifecycle::mounts::support()),
    "test_proxy_connection" => {
        let url = str_arg(&args, "proxyUrl")?;
        ok(crate::http::test_proxy_connection(&url).await?)
    },

    // --- transfers: submitting and recording are one step, so rclone never runs a transfer the
    // ledger has not heard of; the list and the details are plain reads. ------------------------
    "transfers_start" => {
        let request: StartRequest = serde_json::from_value(args["transfer"].clone())
            .map_err(|e| format!("invalid 'transfer': {}", e))?;
        ok(st.transfers.start(request).await?)
    },
    "transfers_stop" => {
        st.transfers.stop(&str_arg(&args, "id")?).await?;
        ok(Value::Null)
    },
    "transfers_list" => {
        let dirs = st.dirs.clone();
        let limit = args["limit"].as_u64().map(|n| n as usize);
        ok(blocking(move || Ok(transfers::list(&dirs, limit))).await?)
    },
    "transfers_detail" => {
        let dirs = st.dirs.clone();
        let id = str_arg(&args, "id")?;
        ok(blocking(move || transfers::detail(&dirs, &id)).await?)
    },
    "download_link" => {
        let fs = str_arg(&args, "fs")?;
        let remote = str_arg(&args, "remote")?;
        ok(format!("/api/dl/{}", st.downloads.mint(&fs, &remote)))
    },

    // --- schedules ------------------------------------------------------------------------------
    "scheduler_supported" => ok(scheduler::supported(&st.dirs)),
    "scheduler_validate_cron" => ok(scheduler::validate_cron(args["cron"].as_str().unwrap_or(""))),
    "scheduler_register" => {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Args { spec: scheduler::jobfile::JobSpec, enabled: bool }
        let Args { spec, enabled } = parse(&args)?;
        let dirs = st.dirs.clone();
        blocking(move || scheduler::register(&dirs, spec, enabled)).await?;
        ok(Value::Null)
    },
    "scheduler_unregister" => {
        let dirs = st.dirs.clone();
        let task_id = str_arg(&args, "taskId")?;
        blocking(move || scheduler::unregister(&dirs, task_id)).await?;
        ok(Value::Null)
    },
    "scheduler_set_enabled" => {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Args { task_id: String, enabled: bool }
        let Args { task_id, enabled } = parse(&args)?;
        let dirs = st.dirs.clone();
        blocking(move || scheduler::set_enabled(&dirs, task_id, enabled)).await?;
        ok(Value::Null)
    },
    "scheduler_status" => {
        let dirs = st.dirs.clone();
        ok(blocking(move || scheduler::status(&dirs)).await?)
    },
    "scheduler_read_log" => {
        let dirs = st.dirs.clone();
        let task_id = str_arg(&args, "taskId")?;
        ok(blocking(move || scheduler::read_log(&dirs, task_id)).await?)
    },
    "scheduler_read_history" => {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Args { task_id: String, limit: Option<usize> }
        let Args { task_id, limit } = parse(&args)?;
        let dirs = st.dirs.clone();
        ok(blocking(move || scheduler::read_history(&dirs, task_id, limit)).await?)
    },
    // Fire and forget, as a fire is: the page watches the run through `scheduler_status` and the
    // Transfers list, not through this reply.
    "scheduler_run_now" => {
        let task_id = scheduler::runnable_now(&st.dirs, &str_arg(&args, "taskId")?)?;
        tokio::spawn(scheduler::runner::run(
            st.dirs.clone(),
            Arc::clone(&st.transfers),
            task_id,
        ));
        ok(Value::Null)
    },

    // --- notifications --------------------------------------------------------------------------
    "notifications_catalog" => ok(notifications::catalog()),
    "notifications_list_targets" => {
        let dirs = st.dirs.clone();
        ok(blocking(move || notifications::targets::load(&dirs)).await?)
    },
    "notifications_add_target" => {
        #[derive(serde::Deserialize)]
        struct Args { target: notifications::targets::NewTarget }
        let Args { target } = parse(&args)?;
        let dirs = st.dirs.clone();
        ok(blocking(move || notifications::targets::add(&dirs, target)).await?)
    },
    "notifications_update_target" => {
        #[derive(serde::Deserialize)]
        struct Args { id: String, patch: notifications::targets::TargetPatch }
        let Args { id, patch } = parse(&args)?;
        let dirs = st.dirs.clone();
        blocking(move || notifications::targets::update(&dirs, &id, patch)).await?;
        ok(Value::Null)
    },
    "notifications_remove_target" => {
        let dirs = st.dirs.clone();
        let id = str_arg(&args, "id")?;
        blocking(move || notifications::targets::remove(&dirs, &id)).await?;
        ok(Value::Null)
    },
    // Fire-and-forget for the caller: delivery failures are recorded per target and logged.
    "notifications_dispatch" => {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Args { event_id: String, title: String, body: String, data: Option<Value> }
        let Args { event_id, title, body, data } = parse(&args)?;
        let data = data.unwrap_or(Value::Null);
        for line in notifications::dispatch(&st.dirs, &event_id, &title, &body, data).await {
            log::warn!("[notifications] {}", line);
        }
        ok(Value::Null)
    },
    // Errors propagate: the screen shows them in its "Test failed" dialog.
    "notifications_send_test" => {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Args { provider: String, url: String, target_id: Option<String>, name: Option<String> }
        let Args { provider, url, target_id, name } = parse(&args)?;
        notifications::send_test(&st.dirs, &provider, &url, target_id.as_deref(), name.as_deref())
            .await?;
        ok(Value::Null)
    },
    // The SMTP settings as a page may see them: no password, only whether one is saved.
    "smtp_get" => ok(notifications::smtp::view(&st.dirs)?),
    "smtp_set" => {
        #[derive(serde::Deserialize)]
        struct Args { settings: notifications::smtp::SmtpInput }
        let Args { settings } = parse(&args)?;
        ok(notifications::smtp::save(&st.dirs, settings)?)
    },
    "smtp_send_test" => {
        let to = str_arg(&args, "to")?;
        notifications::send_test(&st.dirs, "email", &to, None, None).await?;
        ok(Value::Null)
    },

    // --- the Download page's link lookup --------------------------------------------------------
    "resolve_link" => {
        let url = str_arg(&args, "url")?;
        ok(crate::resolve_link::resolve_link(&st.dirs, url).await?)
    },

    // --- finishing a sign-in on another machine -------------------------------------------------
    "oauth_auth_link" => {
        // rclone's own link only redirects to the provider; the provider's page is the part
        // another machine can actually open. Following the redirect does not consume the login —
        // rclone keeps serving it until the code arrives.
        let (auth_url, _, _) = oauth_callback(st).await?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?;
        let response = client.get(&auth_url).send().await.map_err(|e| e.to_string())?;
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| "rclone did not hand back a sign-in page".to_string())?;
        ok(location.to_string())
    },
    "oauth_deliver_code" => {
        // The other machine's browser could not reach this one, so its callback is replayed here
        // instead. The state must be the login's own: a mismatched one is somebody else's
        // sign-in, and rclone would reject it anyway.
        let code = str_arg(&args, "code")?;
        let state = str_arg(&args, "state")?;
        let (_, origin, expected) = oauth_callback(st).await?;
        if state != expected {
            return Err("that address belongs to a different sign-in".into());
        }
        let url = reqwest::Url::parse_with_params(
            &format!("{}/", origin),
            &[("code", code.as_str()), ("state", state.as_str())],
        )
        .map_err(|e| e.to_string())?;
        st.http.get(url).send().await.map_err(|e| e.to_string())?;
        ok(true)
    },

    // The Filen gateway sends no CORS headers, so the remote form's API-key field cannot post to
    // it; the server posts in its place the way @filen/sdk's client does: anonymous bearer auth
    // and a SHA-512 of the exact body. One host, one shape — not a proxy.
    "filen_gateway" => {
        let endpoint = str_arg(&args, "endpoint")?;
        if !endpoint.starts_with("/v3/") || endpoint.contains("..") {
            return Err("not a Filen endpoint".into());
        }
        let body = serde_json::to_string(&args["body"]).map_err(|e| e.to_string())?;
        let checksum = {
            use sha2::{Digest, Sha512};
            format!("{:x}", Sha512::digest(body.as_bytes()))
        };
        let response = st
            .http
            .post(format!("https://gateway.filen.io{}", endpoint))
            .header("Content-Type", "application/json")
            .header("Authorization", "Bearer anonymous")
            .header("Checksum", checksum)
            .body(body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let text = response.text().await.map_err(|e| e.to_string())?;
        ok(json!({ "status": status, "body": text }))
    },
}

#[cfg(test)]
mod tests {
    use super::RPC_NAMES;

    /// The table is derived from the dispatch arms; what remains to check is that no name is
    /// declared twice.
    #[test]
    fn the_table_names_each_command_once() {
        let mut names = RPC_NAMES.to_vec();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), RPC_NAMES.len(), "a command is declared twice");
        assert_eq!(RPC_NAMES.iter().filter(|n| n.starts_with("team_")).count(), 6);
    }
}
